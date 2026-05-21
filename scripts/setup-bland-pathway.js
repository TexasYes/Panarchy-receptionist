#!/usr/bin/env node
/**
 * setup-bland-pathway.js — create or update the Bland Pathway for Dialog.
 *
 * Why pathways instead of prompt+tools:
 *   Bland's prompt-driven tool-calling has a documented ceiling on instruction
 *   following (we hit it on the spell-back rule AND the warm-transfer trigger
 *   in May 2026 testing). Pathways replace LLM judgment with deterministic
 *   nodes: Webhook nodes ALWAYS call their URL; Transfer Call nodes ALWAYS
 *   transfer; branching is rule-based via responsePathways.
 *
 * Pathway graph:
 *   start (Default) → spell_check (Default) → identify_consultant (Default)
 *                     ↓
 *                  lookup_consultant (Webhook /lookup-employee)
 *                     ↓                                ↓
 *              found=true                       found=false
 *                     ↓                                ↓
 *           collect_reason (Default)        lookup_failed_then_collect (Default)
 *                     ↓                                ↓
 *           confirm_callback (Default) ←────────────┘
 *                     ↓
 *           live_or_message (Default — extracts caller_choice)
 *                ↓               ↓
 *       caller wants "live"   caller wants "message"
 *                ↓               ↓
 *   screen_consultant         recap_then_send → send_message_webhook → goodbye
 *   (Webhook /screen-and-transfer)
 *                ↓        ↓
 *        status=accepted   status anything else
 *                ↓        ↓
 *        transfer_node    recap_then_send
 *                ↓
 *           (call ends naturally after transfer)
 *
 * Usage:
 *   bash scripts/run-setup-bland-pathway.sh
 *
 * Idempotency: stores the pathway_id in `.bland-pathway-id` so re-runs PATCH
 * the existing pathway instead of creating duplicates. Tool wiring is by URL,
 * not tool_id, because pathway Webhook nodes embed the URL+body inline rather
 * than referencing the v1 Tools registry.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BLAND_API_KEY = process.env.BLAND_API_KEY;
if (!BLAND_API_KEY) { console.error('ERROR: set BLAND_API_KEY first.'); process.exit(1); }

const WEBHOOK_SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || '';
const RAILWAY_BASE = process.env.SELF_BASE_URL || 'https://dialog-receptionist-webhook-production.up.railway.app';
const PATHWAY_ID_FILE = path.join(__dirname, '..', '.bland-pathway-id');
const COOKIE_JAR = path.join(__dirname, '..', '.bland-cf-cookies.txt');

// ── Bland API helper (curl spawn — Cloudflare WAF blocks Node TLS fingerprint) ──
function api(method, route, body) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS', '-X', method,
      `https://api.bland.ai${route}`,
      '-H', `authorization: ${BLAND_API_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-c', COOKIE_JAR, '-b', COOKIE_JAR,
      '-w', '\n__HTTP_STATUS__:%{http_code}',
    ];
    if (body !== undefined && body !== null) args.push('-d', JSON.stringify(body));
    const proc = spawn('curl', args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (exitCode) => {
      if (exitCode !== 0) return reject(new Error(`curl exit ${exitCode}: ${stderr.trim()}`));
      const m = stdout.match(/\n__HTTP_STATUS__:(\d+)\s*$/);
      if (!m) return reject(new Error(`bad output: ${stdout.slice(-200)}`));
      const status = parseInt(m[1], 10);
      const responseBody = stdout.slice(0, m.index);
      if (status >= 400) return reject(new Error(`HTTP ${status} ${method} ${route}: ${responseBody.slice(0, 500)}`));
      try { resolve(JSON.parse(responseBody)); }
      catch (e) { reject(new Error(`bad JSON (${status}): ${responseBody.slice(0, 200)}`)); }
    });
  });
}

// ── Pathway definition ───────────────────────────────────────────────────────
// Note on text vs prompt fields:
//   `text`  → STATIC. Spoken verbatim. Use when wording must be exact (greetings,
//             confirmation phrasings, the spell-back prompt).
//   `prompt` → DYNAMIC. Fed to the LLM as instructions for that node's behavior.
//             Use when we need the model to extract vars or branch on intent.
function buildPathway() {
  const authHeader = WEBHOOK_SHARED_SECRET; // sent as Authorization to our Railway webhooks

  const nodes = [
    // ── 1. START — greet, collect caller info, apply spell-back inline ──
    // v5: the standalone spell_check node looped on short names because Bland
    // pathway edges only fire after a USER turn. Saying "Thanks." with no
    // question = no user turn = no advance. Spell-back logic now lives inside
    // start, which already asks questions and naturally collects user turns.
    {
      id: 'start',
      type: 'Default',
      data: {
        name: 'Greet + collect caller info (with inline spell-back)',
        text: 'Thank you for calling Dialog, this is Michael, how can I help you?',
        prompt:
          'You are Michael, the Dialog receptionist. The static greeting above is spoken automatically. ' +
          'Your job in THIS node is to collect, by the end: caller first name, last name, company name, AND the target consultant\'s first + last name (so we can look them up). ' +
          '\n\nLISTEN TO THE OPENING TURN. The caller often gives most/all of this in one breath (e.g. "Hi, this is John Smith from Acme calling for Bob Gutermuth"). Extract whatever is present into the variables. DO NOT re-ask for info already given.' +
          '\n\nSPELL-BACK RULE (apply when caller\'s LAST NAME is captured): Count its letters. ' +
          'If 7 OR MORE (Henderson=9, Anderson=8, Gutermuth=9, Smithson=8, Johnson=7, Mitchell=8): say EXACTLY "Could you spell that for me so that I\'m sure to get it correct?" — wait — then read the spelling back letter by letter ("S, M, I, T, H — got it."). ' +
          'If 6 OR FEWER (Smith=5, Lee=3, Conway=6, Wilson=6, Adams=5): do NOT ask to spell. Just internally note the name and move on.' +
          '\n\nMISSING-INFO LOOP: After spell-back (or skipping it), check what\'s still missing. Ask for ONE piece at a time, briefly:' +
          '\n  - If no caller first/last name: "Could I get your first and last name, please?"' +
          '\n  - If no company: "And what company are you with?" (if they decline, set caller_company to "Unknown")' +
          '\n  - If no target consultant: "Who would you like to speak with?"' +
          '\n  - If only a target first name: "We have several {{wanted_consultant_first}}s at Dialog. Can you give me their last name as well?"' +
          '\n\nADVANCE CONDITION: when you have all 5 vars (caller_first/last, company, target first/last), say a brief acknowledgment ("OK, got it.") and the system will move on. ' +
          '\n\nFORBIDDEN PHRASES: never say "let me look that up", "let me check", "let me find", "looking that up", "checking on that". The lookup is automatic; do not narrate it.',
        isStart: true,
        extractVars: [
          ['caller_first_name', 'string', "Caller's first name"],
          ['caller_last_name', 'string', "Caller's last name"],
          ['caller_company', 'string',
            "Caller's company name. If they don't volunteer one, ASK for it before advancing. " +
            "If they decline to share, default to the literal string \"Unknown\" (NEVER leave as null — the recap reads 'null' aloud)."],
          ['wanted_consultant_first', 'string', 'First name of the Dialog consultant they want to reach'],
          ['wanted_consultant_last', 'string', 'Last name of the Dialog consultant they want to reach'],
        ],
      },
    },

    // ── 2. LOOKUP_CONSULTANT — webhook fires DIRECTLY after start (no separate
    // identify_consultant node, since start now collects wanted_consultant_first
    // and wanted_consultant_last). Body inlines the concatenation.
    {
      id: 'lookup_consultant',
      type: 'Webhook',
      data: {
        name: 'Look up consultant',
        url: `${RAILWAY_BASE}/lookup-employee`,
        method: 'POST',
        text: '',  // silent during lookup — typically <1s
        headers: { Authorization: authHeader },
        body: JSON.stringify({ employee_name: '{{wanted_consultant_first}} {{wanted_consultant_last}}' }),
        responseData: [
          { data: '$.found',  name: 'consultant_found',  context: 'true if found, false otherwise' },
          { data: '$.name',   name: 'consultant_name',   context: "Consultant's full name from directory" },
          { data: '$.email',  name: 'consultant_email',  context: "Consultant's email" },
          { data: '$.phone',  name: 'consultant_phone',  context: "Consultant's E.164 phone" },
          { data: '$.gender', name: 'consultant_gender', context: 'Pronoun (she/he/they)' },
        ],
        responsePathways: [
          ['consultant_found', '==', 'true',  { id: 'tell_unavailable',     name: 'Tell caller consultant is unavailable' }],
          ['consultant_found', '==', 'false', { id: 'fallback_front_desk',  name: 'Fall back to Front Desk' }],
        ],
      },
    },

    // ── 5a. TELL_UNAVAILABLE — found path ──
    // v3 fix: previous version's prompt was SKIPPED by the model — it said
    // "No, that's all. Thanks." instead of the unavailable line. The likely
    // cause was the prompt's instruction-style ("Tell the caller...") which
    // the model interpreted conversationally rather than literally.
    // Fix: use a static `text` field for the literal unavailable line so it
    // is ALWAYS spoken, then use prompt only to handle the reason follow-up.
    // Also: the `reason` extraction was getting "The caller is sending..."
    // (third-person). Description now demands a subject-line phrasing.
    {
      id: 'tell_unavailable',
      type: 'Default',
      data: {
        name: 'Inform caller — consultant unavailable',
        text: '{{consultant_name}} is currently unavailable. I can take a message and let them know you called. What is your call in regards to?',
        prompt:
          'You just told the caller that {{consultant_name}} is unavailable and asked what the call is regarding. Listen to their response and extract a brief topic. ' +
          'If they have already told you the reason earlier in the call (review the conversation history), use that — do not re-ask. ' +
          'If they have not provided a reason yet, wait for their answer.',
        extractVars: [
          ['reason', 'string',
            'TOPIC of the call, phrased as a short subject line for an email (3-8 words). ' +
            'GOOD examples: "Q3 contract follow-up", "Test message", "Pricing question on proposal", "Project status update". ' +
            'BAD examples (NEVER use this phrasing): "The caller is sending a test message", "The caller wants to...", "John is calling to...". ' +
            'Strip ALL references to "the caller" or the caller\'s name — extract just the subject/topic itself.'],
          ['details', 'string',
            'Optional longer description (1-2 sentences) of what the caller wants. Can include caller context. If not given, defaults to the reason value.'],
        ],
      },
    },

    // ── 5b. FALLBACK_FRONT_DESK — not-found path ──
    // v3 fix: same static-text + tightened reason extraction as tell_unavailable.
    {
      id: 'fallback_front_desk',
      type: 'Default',
      data: {
        name: 'Fallback — Front Desk',
        text: "I'm not finding that name in our directory. I'll route your message to our front desk, who will get it to the right person. What is your call in regards to?",
        prompt:
          'You just told the caller that we are routing to the Front Desk and asked what the call is regarding. Listen to their response and extract a brief topic.',
        extractVars: [
          ['reason', 'string',
            'TOPIC of the call, phrased as a short subject line for an email (3-8 words). ' +
            'GOOD examples: "Q3 contract follow-up", "Test message", "Pricing question on proposal". ' +
            'BAD: "The caller is...", "John is calling to...". ' +
            'Strip ALL references to "the caller" — extract just the subject/topic.'],
          ['details', 'string', 'Optional longer description (1-2 sentences) of what the caller wants.'],
        ],
      },
    },

    // ── 6. CONFIRM_CALLBACK — confirm callback number ──
    {
      id: 'confirm_callback',
      type: 'Default',
      data: {
        name: 'Confirm callback number',
        prompt:
          'Ask: "Is {{from}} the best number for us to call you back on?" ' +
          'If they say yes, use {{from}} as the callback number. ' +
          'If they give a different number, use that — read it back digit-by-digit to confirm.',
        extractVars: [
          ['callback_number', 'string', 'Callback number in E.164 format (like +15125551234). Default to {{from}} if they confirmed it.'],
        ],
      },
    },

    // ── 7. RECAP — read back the full message and get confirmation ──
    {
      id: 'recap',
      type: 'Default',
      data: {
        name: 'Recap message before sending',
        prompt:
          'Say: "Just to confirm — I will let {{consultant_name}} know that {{caller_first_name}} {{caller_last_name}} from {{caller_company}} called about {{reason}}, and that you can be reached at {{callback_number}}. Is that right?" ' +
          'Wait for the caller to confirm. If they correct anything, update your understanding and recap again.',
      },
    },

    // ── 8. SEND_MESSAGE — webhook: email the consultant ──
    // v6 fix: Webhook nodes WITHOUT responsePathways LOOP infinitely after a
    // successful webhook execution — Bland's runtime needs an explicit "next
    // node" pointer. The `edges` array is IGNORED for Webhook-node transitions
    // (confirmed in v5 testing — all 3 variants looped here even after
    // success: true response). Force advance to anything_else regardless of
    // success/failure (the email backend handles failures internally; caller
    // doesn't need to know).
    {
      id: 'send_message',
      type: 'Webhook',
      data: {
        name: 'Send message email',
        url: `${RAILWAY_BASE}/send-message`,
        method: 'POST',
        text: 'Sending your message now.',
        headers: { Authorization: authHeader },
        body: JSON.stringify({
          toEmail: '{{consultant_email}}',
          toName: '{{consultant_name}}',
          callerName: '{{caller_first_name}} {{caller_last_name}}',
          callerCompany: '{{caller_company}}',
          callerNumber: '{{callback_number}}',
          summary: '{{reason}}',
          details: '{{details}}',
        }),
        responseData: [
          { data: '$.success', name: 'send_success', context: 'true if email sent successfully' },
        ],
        responsePathways: [
          ['send_success', '==', 'true',  { id: 'anything_else', name: 'Wrapup' }],
          ['send_success', '==', 'false', { id: 'anything_else', name: 'Wrapup' }],
        ],
      },
    },

    // ── 9. ANYTHING_ELSE — check for additional asks ──
    {
      id: 'anything_else',
      type: 'Default',
      data: {
        name: 'Anything else?',
        prompt:
          'Ask: "Anything else I can help you with?" ' +
          'If they say no, proceed to goodbye. ' +
          'If they have another request, acknowledge it briefly and end the call (we can only handle one message per call).',
      },
    },

    // ── 10. GOODBYE — End Call node ──
    {
      id: 'goodbye',
      type: 'End Call',
      data: {
        name: 'Goodbye',
        prompt: 'Say: "Thanks for calling Dialog. I hope you have a great rest of your day." Then end the call.',
      },
    },

    // Global config — applies to all nodes (style + voice notes)
    {
      globalConfig: {
        globalPrompt:
          'This is a phone call. Speak warmly, concisely, naturally — at a MODERATE, unhurried pace. ' +
          'Do not use exclamation marks. Briefly acknowledge each caller turn (okay, got it, sure, thanks) BEFORE your next question. ' +
          'Never go silent for more than 2 seconds. ' +
          'NEVER say "let me look that up", "let me check on that", or any lookup-suggesting phrase. ' +
          'Track the opening sentence — never re-ask info the caller already gave. ' +
          'If asked whether you are an AI, say: "Yes, I am a custom AI built by Dialog as they modernized all of their systems using AI." ' +
          // v4: phone number readout formatting
          'PHONE NUMBER FORMATTING: when reading any phone number aloud (callback numbers, etc.), ALWAYS drop the leading "+1" country code and ' +
          'read the digits with PAUSES grouped 3-3-4: area code, pause, next three digits, pause, last four digits. ' +
          'Example: +15128038103 must be read as "five one two... eight oh three... eight one zero three" (with ellipses indicating brief pauses). ' +
          'NEVER say "plus one" before the number. NEVER read the number as a single run-on string of digits.',
      },
      position: { x: 0, y: 0 },
    },
  ];

  const edges = [
    // v5: dropped spell_check and identify_consultant nodes. Spell-back happens
    // inside start (collected as part of name extraction); consultant first+last
    // are collected directly in start, so lookup webhook fires right after start.
    { id: 'e1',  source: 'start',                target: 'lookup_consultant',    data: { label: 'Caller has provided their name, company, and target consultant\'s full name' } },
    // lookup_consultant → tell_unavailable | fallback_front_desk (via responsePathways)
    { id: 'e2',  source: 'tell_unavailable',     target: 'confirm_callback',     data: { label: 'After collecting reason' } },
    { id: 'e3',  source: 'fallback_front_desk',  target: 'confirm_callback',     data: { label: 'After collecting reason' } },
    { id: 'e4',  source: 'confirm_callback',     target: 'recap',                data: { label: 'Callback confirmed' } },
    { id: 'e5',  source: 'recap',                target: 'send_message',         data: { label: 'Caller confirms message' } },
    { id: 'e6',  source: 'send_message',         target: 'anything_else',        data: { label: 'Email sent' } },
    { id: 'e7',  source: 'anything_else',        target: 'goodbye',              data: { label: 'No further requests' } },
  ];

  return {
    name: 'Dialog Receptionist (Michael) — Pathway v1',
    description: 'Deterministic pathway version: greeting → identify caller → lookup consultant → take message → email. Built 2026-05-11 to replace prompt+tools which had instruction-following gaps on tool invocation. Transfer/screen flow can be added as a branch off "tell_unavailable" later.',
    nodes,
    edges,
  };
}

// ── Create or update pathway ─────────────────────────────────────────────────
async function upsertPathway() {
  let pathwayId = null;
  if (fs.existsSync(PATHWAY_ID_FILE)) {
    pathwayId = fs.readFileSync(PATHWAY_ID_FILE, 'utf8').trim();
  }

  const pathway = buildPathway();

  if (pathwayId) {
    console.log(`  • updating existing pathway ${pathwayId}`);
    // Bland's update endpoint is PUT /v1/pathway/{id} (or v2 might differ).
    // POST returned 400 in May 2026 testing; PUT matches the v1 docs example.
    try {
      const r = await api('PUT', `/v1/pathway/${pathwayId}`, pathway);
      console.log(`    → ${r.status || 'updated'}`);
      return pathwayId;
    } catch (e) {
      console.warn(`    update failed (${e.message.slice(0, 200)}) — creating fresh`);
    }
  }

  console.log('  • creating new pathway');
  const created = await api('POST', '/v1/pathway/create', pathway);
  pathwayId =
    created?.pathway_id ||
    created?.pathway?.pathway_id ||
    created?.data?.pathway_id ||
    created?.id;
  if (!pathwayId) {
    throw new Error('pathway created but no pathway_id in response: ' + JSON.stringify(created).slice(0, 300));
  }
  fs.writeFileSync(PATHWAY_ID_FILE, pathwayId);
  console.log(`  • created pathway ${pathwayId} (saved to .bland-pathway-id)`);
  return pathwayId;
}

(async () => {
  console.log('=== Bland Pathway setup ===\n');
  const pathwayId = await upsertPathway();
  console.log('\n=== Done ===');
  console.log(`pathway_id: ${pathwayId}`);
  console.log('\nNext steps:');
  console.log('  1. Test in Bland dashboard simulator before attaching to production');
  console.log(`  2. To attach to +15126979425, POST /v1/inbound/+15126979425 with { "pathway_id": "${pathwayId}" }`);
  console.log('  3. Then make a real test call');
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
