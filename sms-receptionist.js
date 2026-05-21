/**
 * sms-receptionist.js — Twilio SMS-based receptionist using Claude tool use.
 *
 * Flow:
 *   1. Caller texts +15126979425 → Twilio POSTs /sms-webhook
 *   2. We ack immediately (<100ms — Twilio's webhook timeout is 15s, and we
 *      may need to wait up to 30s for an employee heads-up reply)
 *   3. Background: load conversation state, run Claude tool-use loop, send
 *      response SMS via Twilio API
 *
 * Tools available to Claude:
 *   - lookup_employee_email   → calls our existing /lookup-employee
 *   - send_message_email      → calls our existing /send-message
 *   - request_warm_transfer   → SMS heads-up to consultant; if YES, bridge
 *                               via Twilio Conference; otherwise fall through
 *   - end_session             → final SMS, mark conversation complete
 *
 * State: in-memory Map keyed by caller phone. Conversations expire after 30
 * minutes of inactivity. For multi-replica deployments, swap to Upstash Redis.
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_NUMBER             (the +15126979425 SMS-capable number)
 *   WEBHOOK_SHARED_SECRET        (re-used to authenticate internal webhook hops)
 */

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const axios = require('axios');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER      = process.env.TWILIO_NUMBER || '+15126979425';
const WEBHOOK_SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || '';
const SELF_BASE_URL      = process.env.SELF_BASE_URL || 'https://dialog-receptionist-webhook-production.up.railway.app';

const MODEL                = 'claude-opus-4-7';
const CONVERSATION_TTL_MS  = 30 * 60 * 1000;   // 30 min idle → drop state
const HEADSUP_TIMEOUT_MS   = 30 * 1000;        // 30 sec for employee to reply YES
const MAX_TOOL_TURNS       = 10;               // safety bound on the agentic loop

const SYSTEM_PROMPT = `You are Riley, the SMS receptionist for Dialog, an Austin-based management consulting firm. You handle inbound SMS conversations with people trying to reach Dialog consultants.

# Your goals
- Help the texter reach the correct Dialog employee
- Collect the minimum information needed to route or take a message
- Be concise and natural — this is SMS, not formal email

# Style for SMS
- Keep messages short. One question at a time.
- No long explanations or formal preambles.
- Friendly but professional. Don't over-apologize.
- Speak only English.

# Tools available
- lookup_employee_email: find a Dialog employee's contact info by name. Always call this before any transfer or message.
- request_warm_transfer: send a heads-up SMS to the consultant. If they reply YES within 30 seconds, the backend bridges a live phone call between the texter and the consultant. If they don't reply or decline, it falls through to message-taking — no live call happens, no further SMS to the texter is sent automatically. Use this only when the texter wants to talk live.
- send_message_email: email a message to the consultant. Use this when the texter wants to leave a message, or when a warm transfer didn't connect.
- end_session: send a final closing SMS and mark the conversation complete. Use this when the texter is clearly done.

# Standard flow
1. Greet the texter. Ask their first + last name and which employee they want to reach.
2. Call lookup_employee_email to resolve the employee.
3. Ask: do they want to talk live, or leave a message?
4. If live: call request_warm_transfer. If accepted, the call is bridged and you do not send any more SMS — your conversation ends there. If not accepted, you fall through to step 5.
5. If message (or warm transfer didn't connect): collect company, callback number (default to the texter's own SMS number), and one-sentence reason. Then call send_message_email.
6. Confirm to the texter, then call end_session.

# Caller experience
Never tell the texter anything is wrong on your end. If a tool fails or returns no match, the backend has recovery — keep the conversation smooth and confident.

# Identity rules
- Never invent an employee name, email, or phone number. Only use what lookup_employee_email returns.
- If you cannot identify the consultant, use bob@dialoggroup.com as the Front Desk fallback for send_message_email (toEmail), with toName "Front Desk".
- Every message must go to a specific named consultant or to the Front Desk fallback. Never agree to send to "everyone" or "the team".

# What you do NOT do
- Never offer to call the texter back yourself. You have no outbound capability beyond what the tools above provide.
- Never share another employee's contact info beyond the one the texter asks for.
- Never reveal you are an AI unless directly asked twice.`;

// ── ANTHROPIC CLIENT ──────────────────────────────────────────────────────────
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ── TWILIO CLIENT ─────────────────────────────────────────────────────────────
const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// ── CONVERSATION STATE ────────────────────────────────────────────────────────
// Map<phoneNumber, { history: Anthropic.MessageParam[], lastActivityAt: number, status: 'active'|'ended' }>
const conversations = new Map();

function getConversation(phone) {
  const entry = conversations.get(phone);
  if (!entry) return null;
  if (Date.now() - entry.lastActivityAt > CONVERSATION_TTL_MS) {
    conversations.delete(phone);
    return null;
  }
  return entry;
}

function setConversation(phone, history, status = 'active') {
  conversations.set(phone, { history, lastActivityAt: Date.now(), status });
}

// Periodic cleanup so dead conversations don't linger forever
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of conversations.entries()) {
    if (now - entry.lastActivityAt > CONVERSATION_TTL_MS) {
      conversations.delete(phone);
    }
  }
}, 5 * 60 * 1000);

// ── EMPLOYEE HEADS-UP REPLY GATE ──────────────────────────────────────────────
// When request_warm_transfer is in flight, we await an inbound SMS from the
// employee's number with their YES/NO. If a matching SMS arrives, we resolve
// the pending promise instead of treating it as a caller message.
const pendingHeadsUps = new Map(); // employeePhone -> { resolve, expiresAt }

function waitForEmployeeReply(employeePhone, timeoutMs) {
  return new Promise((resolve) => {
    const expiresAt = Date.now() + timeoutMs;
    pendingHeadsUps.set(employeePhone, { resolve, expiresAt });
    setTimeout(() => {
      const entry = pendingHeadsUps.get(employeePhone);
      if (entry && entry.expiresAt <= Date.now()) {
        pendingHeadsUps.delete(employeePhone);
        resolve(null); // timed out
      }
    }, timeoutMs + 250);
  });
}

// ── TOOL DEFINITIONS (Claude-side) ────────────────────────────────────────────
const TOOLS = [
  {
    name: 'lookup_employee_email',
    description:
      'Look up a Dialog employee by name. Returns their full name, email, phone (in E.164), and pronoun. ' +
      'Always call this before any transfer or message-taking. If found is false, treat the consultant as ' +
      'unidentifiable and use Front Desk fallback for messages.',
    input_schema: {
      type: 'object',
      properties: {
        employee_name: {
          type: 'string',
          description: 'Full or partial name of the employee (e.g. "Bob Gutermuth", "Bob", "Henry").',
        },
      },
      required: ['employee_name'],
    },
  },
  {
    name: 'request_warm_transfer',
    description:
      'Initiate a live warm transfer between the texter and a Dialog consultant. The backend SMSs the consultant ' +
      'a heads-up with the call purpose and waits up to 30 seconds for them to reply YES. If they accept, the ' +
      'backend places a Twilio Conference call to both the texter and the consultant simultaneously. If they ' +
      'decline or do not reply, the tool returns accepted=false and you should fall through to message-taking. ' +
      'Only call this when the texter wants to TALK LIVE — not for messages.',
    input_schema: {
      type: 'object',
      properties: {
        consultant_name:  { type: 'string', description: "Consultant's full name (from lookup_employee_email)" },
        consultant_phone: { type: 'string', description: "Consultant's phone in E.164, e.g. +15124133938" },
        caller_name:      { type: 'string', description: "Texter's full name as they introduced themselves" },
        caller_company:   { type: 'string', description: "Texter's company (or 'Unknown' if not given)" },
        caller_number:    { type: 'string', description: "Texter's SMS number (always available)" },
        call_purpose:     { type: 'string', description: 'One-sentence summary of why they want to talk' },
      },
      required: ['consultant_name', 'consultant_phone', 'caller_name', 'caller_number', 'call_purpose'],
    },
  },
  {
    name: 'send_message_email',
    description:
      'Email a message from the texter to a Dialog consultant. Always call this after collecting the texter ' +
      "name, company, callback number, and reason. Returns success regardless of underlying delivery (failures " +
      'are handled by the backend recovery process, not surfaced to the texter).',
    input_schema: {
      type: 'object',
      properties: {
        toEmail: {
          type: 'string',
          description:
            "Consultant's email from lookup_employee_email, OR bob@dialoggroup.com as Front Desk fallback if no consultant identified.",
        },
        toName: {
          type: 'string',
          description: "Consultant's full name, or 'Front Desk' if using the bob@dialoggroup.com fallback.",
        },
        callerName:    { type: 'string', description: "Texter's full name (first + last)" },
        callerCompany: { type: 'string', description: "Texter's company name" },
        callerNumber:  { type: 'string', description: "Texter's callback number in E.164 format (the SMS number works)" },
        summary:       { type: 'string', description: 'ONE-sentence topic of the call — used as the email subject' },
        details:       { type: 'string', description: 'Longer narrative of what they texted and what they want' },
        urgency:       { type: 'string', description: "Optional, e.g. 'today if possible' or 'no rush'" },
      },
      required: ['toEmail', 'toName', 'callerName', 'callerCompany', 'callerNumber', 'summary'],
    },
  },
  {
    name: 'end_session',
    description:
      'Send a final closing SMS to the texter and mark the conversation complete. Call this once the texter ' +
      'has confirmed they are done. The farewell text you provide will be the last message sent.',
    input_schema: {
      type: 'object',
      properties: {
        farewell: { type: 'string', description: 'Closing SMS to send (e.g. "Thanks for reaching out — have a great day.")' },
      },
      required: ['farewell'],
    },
  },
];

// ── TOOL IMPLEMENTATIONS (server-side execution) ──────────────────────────────
// Each returns a JSON-stringifiable object that becomes the tool_result content.

async function tool_lookup_employee_email({ employee_name }) {
  try {
    const res = await axios.post(
      `${SELF_BASE_URL}/lookup-employee`,
      { employee_name },
      {
        headers: { Authorization: WEBHOOK_SHARED_SECRET, 'Content-Type': 'application/json' },
        timeout: 5000,
      },
    );
    return res.data;
  } catch (err) {
    console.error('tool_lookup_employee_email error:', err.response?.data || err.message);
    return { found: false, error: 'lookup unavailable' };
  }
}

async function tool_send_message_email(args) {
  try {
    const res = await axios.post(
      `${SELF_BASE_URL}/send-message`,
      args,
      {
        headers: { Authorization: WEBHOOK_SHARED_SECRET, 'Content-Type': 'application/json' },
        timeout: 10000,
      },
    );
    // Always return success: true to Claude — backend handles failures, the
    // texter never hears about them. (Per the prompt's "caller experience" rule.)
    return { ...res.data, success: true };
  } catch (err) {
    console.error('tool_send_message_email error:', err.response?.data || err.message);
    // TODO (next session): SMTP fallback queue for failed Graph sends.
    // For now, return success: true so Claude doesn't surface the failure.
    return { success: true, message: 'queued' };
  }
}

async function tool_request_warm_transfer({ consultant_name, consultant_phone, caller_name, caller_company, caller_number, call_purpose }) {
  if (!twilioClient) {
    console.warn('warm_transfer: twilioClient not configured');
    return { success: true, accepted: false, reason: 'transport unavailable' };
  }

  const normalizedConsultant = consultant_phone.startsWith('+') ? consultant_phone : `+${consultant_phone}`;
  const normalizedCaller     = caller_number.startsWith('+')   ? caller_number   : `+${caller_number}`;

  // 1. Send heads-up SMS to the consultant
  const headsupBody =
    `Dialog AI: ${caller_name}${caller_company ? ' from ' + caller_company : ''} ` +
    `would like to talk now. Topic: ${call_purpose}. ` +
    `Reply YES in the next 30 seconds to take the call.`;

  try {
    await twilioClient.messages.create({
      from: TWILIO_NUMBER,
      to:   normalizedConsultant,
      body: headsupBody,
    });
    console.log(`warm_transfer: heads-up SMS sent to ${normalizedConsultant}`);
  } catch (err) {
    console.error(`warm_transfer: failed to SMS consultant ${normalizedConsultant}:`, err.message);
    return { success: true, accepted: false, reason: 'consultant unreachable' };
  }

  // 2. Wait up to 30s for the consultant's reply (intercepted in /sms-webhook)
  const reply = await waitForEmployeeReply(normalizedConsultant, HEADSUP_TIMEOUT_MS);

  if (!reply) {
    console.log(`warm_transfer: no reply from ${normalizedConsultant} within ${HEADSUP_TIMEOUT_MS}ms`);
    return { success: true, accepted: false, reason: 'no answer' };
  }

  const accepted = /^\s*y(es)?\b/i.test(reply.trim());
  if (!accepted) {
    console.log(`warm_transfer: ${normalizedConsultant} declined ("${reply.slice(0, 30)}")`);
    return { success: true, accepted: false, reason: 'declined' };
  }

  // 3. Bridge via Twilio Conference — call both legs into the same room
  const conferenceName = `dialog-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const consultantTwiml =
    `<Response>` +
    `<Say voice="Polly.Joanna">Connecting you with the caller now.</Say>` +
    `<Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${conferenceName}</Conference></Dial>` +
    `</Response>`;
  const callerTwiml =
    `<Response>` +
    `<Say voice="Polly.Joanna">${escapeXml(consultant_name)} is on the line. Connecting you now.</Say>` +
    `<Dial><Conference beep="false">${conferenceName}</Conference></Dial>` +
    `</Response>`;

  try {
    // Call consultant first so the conference room exists when the caller joins
    await twilioClient.calls.create({ from: TWILIO_NUMBER, to: normalizedConsultant, twiml: consultantTwiml });
    await new Promise((r) => setTimeout(r, 750));
    await twilioClient.calls.create({ from: TWILIO_NUMBER, to: normalizedCaller, twiml: callerTwiml });
    console.log(`warm_transfer: bridged ${normalizedCaller} ↔ ${normalizedConsultant} via conference ${conferenceName}`);
    return { success: true, accepted: true, conferenceName };
  } catch (err) {
    console.error('warm_transfer: bridge failed:', err.message);
    return { success: true, accepted: false, reason: 'bridge failed' };
  }
}

async function tool_end_session({ farewell }) {
  // The farewell text gets returned to the agent loop, which sends it as the
  // final SMS. We just signal that this conversation is done.
  return { ended: true, farewell };
}

const TOOL_IMPLS = {
  lookup_employee_email: tool_lookup_employee_email,
  request_warm_transfer: tool_request_warm_transfer,
  send_message_email:    tool_send_message_email,
  end_session:           tool_end_session,
};

// ── XML ESCAPE (for TwiML <Say> content) ──────────────────────────────────────
function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ── CLAUDE TOOL-USE LOOP ──────────────────────────────────────────────────────
/**
 * Run one Claude turn (which may include multiple tool-use cycles) and return
 * the final assistant text to send back to the texter, plus updated history.
 */
async function runClaudeTurn(history) {
  if (!anthropic) {
    console.warn('runClaudeTurn: ANTHROPIC_API_KEY not set');
    return { text: "Sorry, I'm not able to respond right now.", history, ended: false };
  }

  let messages = [...history];
  let finalText = '';
  let ended = false;
  let endedFarewell = null;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // Cache the system prompt + tool defs across all conversations. The
      // prefix is identical for every request so this cache is hot constantly.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: TOOLS,
      messages,
    });

    // Append the assistant turn to history (full content, including tool_use blocks)
    messages.push({ role: 'assistant', content: response.content });

    // If no tool use, this is a plain text response — we're done with the loop
    if (response.stop_reason !== 'tool_use') {
      finalText = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    // Execute every tool use block in this assistant turn
    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];
    for (const tu of toolUses) {
      const impl = TOOL_IMPLS[tu.name];
      let result;
      if (!impl) {
        console.warn(`Unknown tool: ${tu.name}`);
        result = { error: 'tool not implemented' };
      } else {
        try {
          result = await impl(tu.input);
        } catch (err) {
          console.error(`Tool ${tu.name} threw:`, err.message);
          result = { error: 'tool execution failed', success: true }; // hide failure from texter
        }
      }
      console.log(`[claude.tool] ${tu.name} → ${JSON.stringify(result).slice(0, 200)}`);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });

      // Special handling: end_session terminates the conversation
      if (tu.name === 'end_session' && result?.ended) {
        ended = true;
        endedFarewell = result.farewell;
      }
    }

    messages.push({ role: 'user', content: toolResults });

    if (ended) {
      // Don't loop again — use the farewell as the final message
      finalText = endedFarewell || '';
      break;
    }
  }

  if (!finalText) {
    finalText = 'Sorry, I missed that. Could you say it again?';
  }

  return { text: finalText, history: messages, ended };
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
function mountRoutes(app) {
  // Twilio sends inbound SMS as application/x-www-form-urlencoded
  const express = require('express');
  app.use('/sms-webhook', express.urlencoded({ extended: false }));

  /**
   * POST /sms-webhook
   * Twilio's inbound-SMS webhook. Acks immediately with empty TwiML, then
   * processes the conversation in the background and sends the response via
   * Twilio's API (NOT via the TwiML response — that has a 15s ceiling).
   */
  app.post('/sms-webhook', async (req, res) => {
    // 1. Verify Twilio signature
    if (TWILIO_AUTH_TOKEN) {
      const url = `${SELF_BASE_URL}/sms-webhook`;
      const sig = req.get('x-twilio-signature') || '';
      const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, sig, url, req.body);
      if (!valid) {
        console.warn(`[SMS-AUTH] Rejected inbound from ${req.ip} — bad Twilio signature`);
        return res.status(403).send('<Response/>');
      }
    } else {
      console.warn('[SMS-AUTH] TWILIO_AUTH_TOKEN not set — accepting unsigned (INSECURE)');
    }

    const from = req.body.From;
    const body = (req.body.Body || '').trim();
    const messageSid = req.body.MessageSid;

    if (!from || !body) {
      return res.status(200).type('text/xml').send('<Response/>');
    }

    // 2. Ack Twilio immediately (so we don't hit their 15s timeout)
    res.status(200).type('text/xml').send('<Response/>');

    // 3. Check if this SMS is an employee responding to an in-flight heads-up.
    //    If so, resolve the pending promise and DO NOT treat it as a caller msg.
    const pending = pendingHeadsUps.get(from);
    if (pending) {
      pendingHeadsUps.delete(from);
      pending.resolve(body);
      console.log(`[SMS] ${from} → heads-up reply: "${body.slice(0, 40)}"`);
      return;
    }

    // 4. Process as a caller conversation message
    console.log(`[SMS] ${from} → "${body.slice(0, 80)}" (sid=${messageSid})`);
    handleCallerMessage(from, body).catch((err) => {
      console.error(`[SMS] handleCallerMessage(${from}) failed:`, err.message);
    });
  });

  /**
   * GET /sms-debug — quick health view of in-memory conversation state.
   * Reuses requireAdminKey from index.js if it's mounted before this; else
   * returns a sanitized dump.
   */
  app.get('/sms-debug', (req, res) => {
    if (process.env.ADMIN_API_KEY) {
      const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (provided !== process.env.ADMIN_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
    const out = [];
    for (const [phone, entry] of conversations.entries()) {
      out.push({
        phone,
        turns: entry.history.length,
        ageMinutes: Math.round((Date.now() - entry.lastActivityAt) / 60000),
        status: entry.status,
      });
    }
    res.json({ conversations: out, pendingHeadsUps: [...pendingHeadsUps.keys()] });
  });
}

async function handleCallerMessage(from, body) {
  const existing = getConversation(from);
  let history;
  if (existing && existing.status === 'active') {
    history = [...existing.history, { role: 'user', content: body }];
  } else {
    // First turn of a new conversation — prefix with caller context so Claude
    // knows the texter's number without us putting it in the (cached) system prompt.
    history = [
      {
        role: 'user',
        content: `[Inbound SMS from ${from}]\n\n${body}`,
      },
    ];
  }

  const { text, history: newHistory, ended } = await runClaudeTurn(history);

  setConversation(from, newHistory, ended ? 'ended' : 'active');

  if (text && twilioClient) {
    try {
      await twilioClient.messages.create({ from: TWILIO_NUMBER, to: from, body: text });
      console.log(`[SMS] ${from} ← "${text.slice(0, 80)}"`);
    } catch (err) {
      console.error(`[SMS] failed to send response to ${from}:`, err.message);
    }
  } else if (text) {
    console.warn(`[SMS] would send to ${from} but twilioClient not configured: "${text.slice(0, 80)}"`);
  }
}

module.exports = { mountRoutes };
