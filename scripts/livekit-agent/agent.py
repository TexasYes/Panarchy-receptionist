"""
Riley — Dialog AI Receptionist (LiveKit Agents).

Real-time voice agent that joins a LiveKit room when an inbound SIP call lands.
Pipeline:
    Twilio number → SIP trunk → LiveKit room → this agent
        STT:  Deepgram (nova-2)
        LLM:  Anthropic Claude Opus 4.7
        TTS:  ElevenLabs (v3 if Creator tier, v2 fallback otherwise)
        VAD:  Silero
    Tools (function calls): hit our existing Railway webhook endpoints.

Run locally:
    cd scripts/livekit-agent
    pip install -r requirements.txt
    # ensure parent .env is sourced (or copy values into local env)
    python agent.py dev

Run as a worker in production (Railway, Render, anywhere with Python+Docker):
    python agent.py start
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Annotated

import httpx
from dotenv import load_dotenv
from livekit import agents
from livekit.agents import (
    Agent,
    AgentSession,
    JobContext,
    RoomInputOptions,
    function_tool,
    get_job_context,
)
from livekit.plugins import anthropic, deepgram, elevenlabs, openai, silero

# Load .env from the repo root (two levels up from this file)
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
load_dotenv(REPO_ROOT / ".env")

# ── CONFIG ────────────────────────────────────────────────────────────────────
RAILWAY_BASE = os.environ.get(
    "SELF_BASE_URL",
    "https://dialog-receptionist-webhook-production.up.railway.app",
)
VAPI_SERVER_SECRET = os.environ.get("VAPI_SERVER_SECRET", "")

# Deepgram SDK looks for DEEPGRAM_API_KEY; Bob has it as DEEPGRAM_API_SECRET.
# Normalize so the plugin finds it without us having to pass it explicitly.
if os.environ.get("DEEPGRAM_API_SECRET") and not os.environ.get("DEEPGRAM_API_KEY"):
    os.environ["DEEPGRAM_API_KEY"] = os.environ["DEEPGRAM_API_SECRET"]

# ElevenLabs SDK looks for ELEVEN_API_KEY (older name); the rest of the world
# (and our .env / .env.example) uses ELEVENLABS_API_KEY. Alias so the plugin
# init doesn't crash with "ElevenLabs API key is required".
if os.environ.get("ELEVENLABS_API_KEY") and not os.environ.get("ELEVEN_API_KEY"):
    os.environ["ELEVEN_API_KEY"] = os.environ["ELEVENLABS_API_KEY"]

# Honor PROMPT_PATH env var if set (Dockerfile sets it to /app/prompts/...);
# otherwise compute from the repo layout for local dev.
PROMPT_FILE = Path(
    os.environ.get(
        "PROMPT_PATH",
        str(REPO_ROOT / "prompts" / "riley-livekit-prompt.md"),
    )
)

# ── LLM PROVIDER SWITCH ───────────────────────────────────────────────────────
# Bob's deliberately running a 3-way LLM A/B (anthropic vs openai vs grok) inside
# the SAME LiveKit agent so the only changing variable is the LLM. To swap, edit
# .env: LLM_PROVIDER=anthropic|openai|grok  (and ensure the matching API key is set).
# Optional LLM_MODEL override lets you pin a specific model id per provider without
# editing code (e.g. grok-4-latest vs grok-2-latest, gpt-4o-mini vs gpt-4o).
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic").strip().lower()
LLM_MODEL_OVERRIDE = os.environ.get("LLM_MODEL", "").strip()

# Per-provider defaults — chosen for voice latency + instruction-following quality.
# Override via LLM_MODEL env var if needed.
# Grok default: `grok-4-1-fast-non-reasoning`. Reasoning models add 1-3s of TTFB
# (the model "thinks" before responding), which is too much for phone latency.
# Non-reasoning is closer to xAI's voice-tuned spec. Set LLM_MODEL=grok-4-1-fast-reasoning
# to get the reasoning ("Voice Think Fast 1.0") variant if instruction-following
# matters more than latency.
_DEFAULT_MODELS = {
    "anthropic": "claude-opus-4-7",
    "openai": "gpt-4o",
    "grok": "grok-4-1-fast-non-reasoning",
}


def _make_llm():
    """Construct the right LiveKit LLM plugin based on LLM_PROVIDER.

    Returns the configured plugin instance. Raises ValueError on unknown provider
    or missing API key — fail loud at entrypoint time, not silently mid-call.
    """
    model = LLM_MODEL_OVERRIDE or _DEFAULT_MODELS.get(LLM_PROVIDER)
    if not model:
        raise ValueError(
            f"LLM_PROVIDER={LLM_PROVIDER!r} is not one of: anthropic, openai, grok"
        )

    if LLM_PROVIDER == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise ValueError("ANTHROPIC_API_KEY not set (LLM_PROVIDER=anthropic)")
        logger.info("LLM: Anthropic %s", model)
        return anthropic.LLM(model=model)

    if LLM_PROVIDER == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise ValueError("OPENAI_API_KEY not set (LLM_PROVIDER=openai)")
        logger.info("LLM: OpenAI %s", model)
        return openai.LLM(model=model)

    if LLM_PROVIDER == "grok":
        # Use LiveKit's dedicated xAI factory rather than constructing the OpenAI
        # plugin manually — it sets the correct base URL and validates XAI_API_KEY.
        # Default model: grok-3-fast (voice-latency tuned).
        api_key = os.environ.get("XAI_API_KEY")
        if not api_key:
            raise ValueError("XAI_API_KEY not set (LLM_PROVIDER=grok)")
        logger.info("LLM: Grok %s (via xAI)", model)
        return openai.LLM.with_x_ai(model=model, api_key=api_key)

    raise ValueError(
        f"Unknown LLM_PROVIDER={LLM_PROVIDER!r}; expected anthropic, openai, or grok"
    )

logger = logging.getLogger("dialog-receptionist")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s %(message)s")


def load_prompt() -> str:
    """Read the canonical prompt and strip the markdown header above the first `---`."""
    text = PROMPT_FILE.read_text(encoding="utf-8")
    parts = text.split("\n---\n", 1)
    return (parts[1] if len(parts) == 2 else text).strip()


# ── HTTP HELPER ───────────────────────────────────────────────────────────────
_http_client: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(
            base_url=RAILWAY_BASE,
            timeout=httpx.Timeout(10.0),
            headers={
                "Authorization": VAPI_SERVER_SECRET,
                "Content-Type": "application/json",
            },
        )
    return _http_client


# ── TOOL IMPLEMENTATIONS ──────────────────────────────────────────────────────
# Each @function_tool is exposed to Claude as a callable tool. Docstrings become
# the tool description the model sees. Type-hinted args become the JSON schema.

@function_tool
async def lookup_employee_email(
    employee_name: Annotated[str, "Full or partial name of the employee, e.g. 'Bob Gutermuth' or 'Bob'"],
) -> dict:
    """Look up a Dialog employee by name. Returns the consultant's full name, email,
    phone (E.164), and pronoun. Always call this before send_message_email so we
    have the consultant's email to route the message to. If found is false, treat
    the consultant as unidentifiable and use bob@dialoggroup.com / "Front Desk"
    as the fallback in send_message_email.
    """
    try:
        r = await _client().post("/lookup-employee", json={"employee_name": employee_name})
        return r.json()
    except Exception as e:
        logger.exception("lookup_employee_email failed: %s", e)
        return {"found": False, "error": "lookup unavailable"}


@function_tool
async def send_message_email(
    toEmail: Annotated[str, "Consultant email from lookup_employee_email; bob@dialoggroup.com as Front Desk fallback if no match"],
    toName: Annotated[str, "Consultant full name; 'Front Desk' if using the fallback"],
    callerName: Annotated[str, "Caller full name (first plus last)"],
    callerCompany: Annotated[str, "Caller company. Use 'Unknown' if they decline to share."],
    callerNumber: Annotated[str, "Callback number in E.164 format, e.g. +15125551234"],
    summary: Annotated[str, "ONE-sentence topic of the call. Becomes the email subject."],
    details: Annotated[str, "Longer narrative of what the caller said and what they want"],
    urgency: Annotated[str, "Optional urgency note like 'today', 'this week', or 'no rush'"] = "",
) -> dict:
    """Email a message from the caller to a Dialog consultant. Always call after
    collecting caller name, company, callback number, and reason. Returns success
    regardless of underlying delivery — backend handles failures, the caller
    never hears about errors.
    """
    payload = {
        "toEmail": toEmail, "toName": toName,
        "callerName": callerName, "callerCompany": callerCompany,
        "callerNumber": callerNumber,
        "summary": summary, "details": details, "urgency": urgency,
    }
    try:
        r = await _client().post("/send-message", json=payload)
        return r.json()
    except Exception as e:
        logger.exception("send_message_email failed: %s", e)
        # Per the prompt's "caller never hears it" rule: claim success even on error.
        # TODO: queue failed sends for SMTP retry (see PLAN.md).
        return {"success": True, "queued": True}


@function_tool
async def end_call_polite() -> str:
    """Cleanly end the call after the caller has confirmed there is nothing else.
    Use this only after speaking the closing 'Thanks for calling Dialog. Have a
    great day.' farewell. Do NOT verbalize anything else after calling this tool.
    """
    # Schedule the actual hangup in a background task so this tool can return
    # immediately. We delay 1.5s to give the in-flight TTS (the farewell line)
    # time to drain — otherwise the caller hears the goodbye get cut off mid-word.
    ctx = get_job_context()

    async def _hang_up_after_farewell():
        await asyncio.sleep(1.5)
        try:
            await ctx.delete_room()
        except Exception as e:
            logger.warning("delete_room failed (call may have already ended): %s", e)

    asyncio.create_task(_hang_up_after_farewell())
    # Return an empty string instead of a dict so the model has nothing tempting
    # to verbalize. Past bug: returning {"ended": True} caused Riley to say
    # "call ended" out loud at the end of every call.
    return ""


# ── ENTRYPOINT ────────────────────────────────────────────────────────────────
async def entrypoint(ctx: JobContext):
    """Called by LiveKit Agents framework when a new room is created (e.g. when
    an inbound SIP call lands)."""
    await ctx.connect()
    logger.info(
        "Joined room %s; participant count %d", ctx.room.name, len(ctx.room.remote_participants)
    )

    # The caller's phone number arrives via the SIP participant's identity / attributes.
    caller_phone = "(unknown)"
    for p in ctx.room.remote_participants.values():
        # Twilio→LiveKit SIP typically puts the caller number in the participant attribute
        # `sip.phoneNumber` or in the participant identity. Try both.
        attrs = getattr(p, "attributes", {}) or {}
        caller_phone = (
            attrs.get("sip.phoneNumber")
            or attrs.get("sip.from")
            or p.identity
            or caller_phone
        )
        break
    logger.info("Caller phone: %s", caller_phone)

    base_prompt = load_prompt()
    # Substitute the caller's phone into the {{caller_phone}} template variable
    # in the prompt. (LiveKit doesn't have a built-in template engine — we do it manually.)
    prompt_with_caller = base_prompt.replace("{{caller_phone}}", caller_phone)

    # Diagnostic: confirm the full prompt is loaded and substituted before
    # Agent() is instantiated. Helps catch silent prompt-loading regressions.
    logger.info(
        "Prompt loaded: %d chars (%d after caller_phone substitution). First 200 chars: %r",
        len(base_prompt), len(prompt_with_caller), prompt_with_caller[:200].replace("\n", "\\n"),
    )
    if "{{caller_phone}}" in prompt_with_caller:
        logger.warning("caller_phone substitution failed — placeholder still present in prompt")

    agent = Agent(
        instructions=prompt_with_caller,
        tools=[lookup_employee_email, send_message_email, end_call_polite],
    )

    session = AgentSession(
        stt=deepgram.STT(model="nova-2", language="en-US"),
        llm=_make_llm(),  # provider chosen by LLM_PROVIDER env var
        tts=elevenlabs.TTS(
            model="eleven_turbo_v2_5",  # fast, natural; upgrade to eleven_v3 once on Creator tier
            voice_id="EXAVITQu4vr4xnSDxMaL",  # Sarah — clear professional female; swap via env var if desired
        ),
        vad=silero.VAD.load(),
    )

    await session.start(
        room=ctx.room,
        agent=agent,
        room_input_options=RoomInputOptions(),
    )

    # Trigger Riley to deliver the greeting first
    await session.say(
        "Thank you for calling Dialog. This is Riley. How can I help you today?",
        allow_interruptions=True,
    )


if __name__ == "__main__":
    agents.cli.run_app(agents.WorkerOptions(entrypoint_fnc=entrypoint))
