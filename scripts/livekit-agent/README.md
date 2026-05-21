# Riley — LiveKit Agent

Real-time voice agent for the LiveKit half of the platform comparison.
See `PLAN.md` (repo root) for the full 3-way Vapi/Bland/LiveKit context.

## Architecture

```
+12513335665 (Twilio)  →  SIP trunk  →  LiveKit room
                                            ↓ joins as participant
                                       agent.py (this dir)
                                            ├── STT: Deepgram nova-2
                                            ├── LLM: Claude Opus 4.7
                                            ├── TTS: ElevenLabs (turbo_v2_5; v3 with Creator tier)
                                            └── Tools: HTTP → Railway endpoints
```

Same Railway endpoints as the Vapi and Bland integrations
(`/lookup-employee`, `/send-message`) — only the orchestration layer changes.

## Local dev

```bash
cd scripts/livekit-agent
pip install -r requirements.txt           # one-time
python agent.py dev                        # runs in dev mode, no auth
```

The `dev` mode opens a LiveKit playground URL in your browser so you can talk
to Riley without configuring SIP. Useful for iterating on the prompt /
behavior without making real phone calls.

## Production deploy (Railway)

Add a second service to the existing `dialog-receptionist` Railway project:

1. Railway → project → New Service → "Deploy from GitHub repo"
2. Select the same repo (`TexasYes/dialog-receptionist-webhook`)
3. Settings → Build → Dockerfile path: `scripts/livekit-agent/Dockerfile`
4. Settings → Variables: copy these from the existing service (or set fresh):
   - `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
   - `DEEPGRAM_API_KEY` (or `DEEPGRAM_API_SECRET` — agent reads either)
   - `ELEVENLABS_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `VAPI_SERVER_SECRET` (for authenticating to our Railway webhook tools)
   - `SELF_BASE_URL` (defaults to `https://dialog-receptionist-webhook-production.up.railway.app`)
5. Deploy. Logs should show `Joined room ...` once SIP routing is configured.

## SIP routing (Twilio → LiveKit)

LiveKit Cloud assigns a SIP URI per project (find it in the project settings).
For our project: `sip:z2s9j1lv8pp.sip.livekit.cloud`.

In Twilio Console:
- Phone Numbers → +12513335665 → Voice & Fax
- "A CALL COMES IN" → SIP → paste `sip:z2s9j1lv8pp.sip.livekit.cloud`
- Save

When that number is dialed, Twilio bridges to LiveKit, LiveKit creates a
room, the agent worker joins, conversation begins.

## Prompt

The system prompt lives at `prompts/riley-livekit-prompt.md` (repo root).
The agent reads it at startup and substitutes `{{caller_phone}}` with the
inbound caller's number from the SIP participant attributes.

To change Riley's behavior, edit that file and either:
- Restart the agent locally (`Ctrl-C` then re-run)
- Push to GitHub → Railway auto-redeploys the worker
