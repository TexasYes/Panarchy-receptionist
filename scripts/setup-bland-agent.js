#!/usr/bin/env node
/**
 * setup-bland-agent.js — create or update the Bland.ai inbound voice agent
 * for Panarchy with our prompt + the lookup/send-message tools wired to our
 * Railway endpoints.
 *
 * V1 scope: agent + 2 tools (lookup_employee_email, send_message_email).
 * Caller can reach Riley → ask for someone → message → email arrives.
 * Warm transfer is V1.5 (needs a new Railway endpoint).
 *
 * Idempotent: stores the agent_id in `.bland-agent-id` so re-runs PATCH the
 * existing agent instead of creating duplicates. Tool definitions are
 * upserted by name.
 *
 * Usage:
 *   BLAND_API_KEY=<key> SELF_BASE_URL=https://panarchy-receptionist-... \
 *   WEBHOOK_SHARED_SECRET=<secret> node scripts/setup-bland-agent.js
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BLAND_API_KEY = process.env.BLAND_API_KEY;
if (!BLAND_API_KEY) { console.error('ERROR: set BLAND_API_KEY first.'); process.exit(1); }

const WEBHOOK_SHARED_SECRET = process.env.WEBHOOK_SHARED_SECRET || '';
const RAILWAY_BASE = process.env.SELF_BASE_URL || 'https://panarchy-receptionist-production.up.railway.app';
const PROMPT_FILE  = path.join(__dirname, '..', 'prompts', 'riley-bland-prompt.md');
const AGENT_ID_FILE = path.join(__dirname, '..', '.bland-agent-id');
const TOOL_IDS_FILE = path.join(__dirname, '..', '.bland-tool-ids.json');

// ── Bland API helper ─────────────────────────────────────────────────────────
// Cloudflare in front of api.bland.ai fingerprints Node's TLS stack and
// returns 403 "Attention Required" for both raw `https` module and axios.
// curl from the same machine works (manual smoke test 2026-05-10), so we
// shell out. Match the exact arg shape the manual test used — `-d <json>`
// inline, no stdin piping — and maintain a cookie jar across requests so
// the __cf_bm bot-management cookie persists (avoids re-challenge on each
// request). Set DEBUG_BLAND=1 to print the equivalent curl command.
const COOKIE_JAR = path.join(__dirname, '..', '.bland-cf-cookies.txt');

function api(method, route, body) {
  return new Promise((resolve, reject) => {
    const url = `https://api.bland.ai${route}`;
    const args = [
      '-sS',
      '-X', method,
      url,
      '-H', `authorization: ${BLAND_API_KEY}`,
      '-H', 'Content-Type: application/json',
      '-H', 'Accept: application/json',
      '-c', COOKIE_JAR,  // write cookies (Cloudflare's __cf_bm) on each response
      '-b', COOKIE_JAR,  // and read them on each request — keeps CF bot trust warm
      '-w', '\n__HTTP_STATUS__:%{http_code}', // delimited so JSON content can't collide with status
    ];
    if (body !== undefined && body !== null) {
      args.push('-d', JSON.stringify(body));
    }
    if (process.env.DEBUG_BLAND === '1') {
      const safe = args.map((a) => /[ "$']/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);
      console.log('[DEBUG_BLAND] curl ' + safe.join(' ').replace(BLAND_API_KEY, '<redacted>'));
    }
    const proc = spawn('curl', args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (exitCode) => {
      if (exitCode !== 0) {
        return reject(new Error(`curl exit ${exitCode}: ${stderr.trim() || '(no stderr)'}`));
      }
      const m = stdout.match(/\n__HTTP_STATUS__:(\d+)\s*$/);
      if (!m) {
        return reject(new Error(`could not parse status from curl output. Last 300 chars: ${stdout.slice(-300)}`));
      }
      const status = parseInt(m[1], 10);
      const responseBody = stdout.slice(0, m.index);
      if (status >= 400) {
        return reject(new Error(`HTTP ${status} ${method} ${route}: ${responseBody.slice(0, 500)}`));
      }
      try { resolve(JSON.parse(responseBody)); }
      catch (e) { reject(new Error(`bad JSON (status ${status}): ${responseBody.slice(0, 200)}`)); }
    });
  });
}

// ── Read prompt body (everything after the first --- separator) ──────────────
function loadPrompt() {
  const md = fs.readFileSync(PROMPT_FILE, 'utf8');
  const lines = md.split('\n');
  const sepIdx = lines.findIndex((l) => l.trim() === '---');
  return (sepIdx === -1 ? md : lines.slice(sepIdx + 1).join('\n')).trim();
}

// ── Tool definitions ─────────────────────────────────────────────────────────
// Bland's custom-tools API: each tool has name, description, input_schema,
// url, method, headers, body (template with {{input.X}} substitution),
// response (JSONPath-style extraction so the agent sees clean values).
function buildToolDefinitions() {
  return [
    {
      name: 'lookup_employee_email',
      description:
        'Look up a Panarchy employee by name. Returns their full name, email, phone, and gender pronoun. ' +
        'Always call this before send_message_email so we have the consultant email to route to.',
      input_schema: {
        type: 'object',
        example: { employee_name: 'Bob Gutermuth' },
        properties: {
          // Note: keep this description free of the substring `' or '` (apostrophes
          // around words with `or` between them) — Cloudflare's WAF in front of
          // api.bland.ai matches that as a SQL-injection signature and 403s the
          // tool-create POST. Verified 2026-05-10.
          employee_name: { type: 'string', description: 'Full or partial name of the employee, e.g. Bob Gutermuth' },
        },
        required: ['employee_name'],
      },
      speech: '',  // stay silent during lookup — usually <1s
      url:    `${RAILWAY_BASE}/lookup-employee`,
      method: 'POST',
      headers: { Authorization: WEBHOOK_SHARED_SECRET },
      body:   { employee_name: '{{input.employee_name}}' },
      response: {
        found:  '$.found',
        name:   '$.name',
        email:  '$.email',
        phone:  '$.phone',
        gender: '$.gender',
      },
    },
    {
      name: 'send_message_email',
      description:
        'Email a message from the caller to a Panarchy team member. Always call this after collecting ' +
        'caller name, company, callback number, and reason. Returns success regardless of underlying ' +
        'delivery — backend handles failures, the caller never hears about errors.',
      input_schema: {
        type: 'object',
        example: {
          toEmail: 'bobgutermuth@panarchy.io',
          toName: 'Bob Gutermuth',
          callerName: 'Jane Smith',
          callerCompany: 'Acme Corp',
          callerNumber: '+15125551234',
          summary: 'Following up on Q3 contract',
          details: 'Jane Smith from Acme called about the Q3 contract status; asked for a callback today.',
          urgency: 'today if possible',
        },
        properties: {
          // Cloudflare WAF: keep all descriptions free of the substring `' or '`
          // (apostrophes around words with `or` between) — matches as SQL injection.
          toEmail:       { type: 'string', description: 'Consultant email from lookup_employee_email, OR bobgutermuth@panarchy.io as the Front Desk fallback' },
          toName:        { type: 'string', description: 'Consultant full name. Use Front Desk when no consultant is identified.' },
          callerName:    { type: 'string', description: 'Caller full name (first plus last)' },
          callerCompany: { type: 'string', description: 'Caller company name. Use Unknown when they decline to share it.' },
          callerNumber:  { type: 'string', description: 'Callback number in E.164 format, for example +15125551234' },
          summary:       { type: 'string', description: 'ONE-sentence topic of the call. Becomes the email subject.' },
          details:       { type: 'string', description: 'Longer narrative of what the caller said and what they want' },
          urgency:       { type: 'string', description: 'Optional urgency note like today, this week, or no rush' },
        },
        required: ['toEmail', 'toName', 'callerName', 'callerCompany', 'callerNumber', 'summary'],
      },
      speech: '',
      url:    `${RAILWAY_BASE}/send-message`,
      method: 'POST',
      headers: { Authorization: WEBHOOK_SHARED_SECRET, 'Content-Type': 'application/json' },
      body: {
        toEmail:       '{{input.toEmail}}',
        toName:        '{{input.toName}}',
        callerName:    '{{input.callerName}}',
        callerCompany: '{{input.callerCompany}}',
        callerNumber:  '{{input.callerNumber}}',
        summary:       '{{input.summary}}',
        details:       '{{input.details}}',
        urgency:       '{{input.urgency}}',
      },
      response: {
        success: '$.success',
        message: '$.message',
      },
    },
  ];
}

// ── Upsert tools (create-if-new, update-if-existing by name) ─────────────────
async function upsertTools(toolDefs) {
  let existingToolIds = {};
  if (fs.existsSync(TOOL_IDS_FILE)) {
    try { existingToolIds = JSON.parse(fs.readFileSync(TOOL_IDS_FILE, 'utf8')); } catch {}
  }

  const ids = {};
  for (const def of toolDefs) {
    const existingId = existingToolIds[def.name];
    if (existingId) {
      console.log(`  • ${def.name}: updating existing tool ${existingId}`);
      try {
        const updated = await api('POST', `/v1/tools/${existingId}`, def);
        ids[def.name] = updated?.tool_id || updated?.id || existingId;
        continue;
      } catch (e) {
        console.warn(`    update failed (${e.message.slice(0, 100)}) — creating fresh`);
      }
    }
    const created = await api('POST', '/v1/tools', def);
    ids[def.name] = created?.tool_id || created?.id;
    console.log(`  • ${def.name}: created tool ${ids[def.name]}`);
  }
  fs.writeFileSync(TOOL_IDS_FILE, JSON.stringify(ids, null, 2));
  return ids;
}

// ── Upsert agent ─────────────────────────────────────────────────────────────
async function upsertAgent(prompt, toolIds) {
  const agentBody = {
    prompt,
    voice: 'adriana', // "Professional American Female" — receptionist-fit; swap via dashboard if needed
    language: 'ENG',
    model: 'enhanced', // base was inconsistent on prompt-following ("look that up" rule); enhanced is smarter
    first_sentence: 'Thank you for calling Panarchy. This is Riley. How can I help you today?',
    tools: Object.values(toolIds), // attach all our tools to the agent by id
    interruption_threshold: 100, // ms — lower = more responsive, higher = less likely to cut off
    max_duration: 10, // minutes — receptionist calls are short; cap protects against runaway costs
    metadata: { source: 'panarchy-receptionist setup-bland-agent.js', version: 'v1' },
  };

  let agentId = null;
  if (fs.existsSync(AGENT_ID_FILE)) {
    agentId = fs.readFileSync(AGENT_ID_FILE, 'utf8').trim();
  }

  if (agentId) {
    console.log(`  • updating existing agent ${agentId}`);
    try {
      await api('POST', `/v1/agents/${agentId}`, agentBody);
      return agentId;
    } catch (e) {
      console.warn(`    update failed (${e.message.slice(0, 100)}) — creating fresh`);
    }
  }
  const created = await api('POST', '/v1/agents', agentBody);
  agentId = created?.agent?.agent_id || created?.agent_id || created?.id;
  if (!agentId) {
    throw new Error('agent created but no agent_id in response: ' + JSON.stringify(created).slice(0, 300));
  }
  fs.writeFileSync(AGENT_ID_FILE, agentId);
  console.log(`  • created agent ${agentId}`);
  return agentId;
}

(async () => {
  console.log('=== Bland.ai agent setup ===\n');

  console.log('1. Loading prompt');
  const prompt = loadPrompt();
  console.log(`   ${prompt.length} chars from ${path.basename(PROMPT_FILE)}`);
  if (prompt.length > 2400) {
    console.warn(`   ⚠️  prompt is over Bland's recommended 2000-char limit — may be truncated or behave oddly`);
  }

  console.log('\n2. Upserting tools');
  const toolDefs = buildToolDefinitions();
  const toolIds = await upsertTools(toolDefs);

  console.log('\n3. Upserting agent');
  const agentId = await upsertAgent(prompt, toolIds);

  console.log('\n=== Done ===');
  console.log(`agent_id:    ${agentId}  (saved to .bland-agent-id)`);
  console.log(`tool ids:    ${JSON.stringify(toolIds)}  (saved to .bland-tool-ids.json)`);
  console.log('\nNext steps:');
  console.log('  1. Bland dashboard → Phone Numbers → Buy a number (free with Start tier)');
  console.log(`  2. Assign that number to inbound agent ${agentId}`);
  console.log('  3. Call the number to test');
  console.log('\nIf you re-run this script, it patches the existing agent + tools instead of creating duplicates.');
})().catch((e) => {
  console.error('\nFAILED:', e.message);
  process.exit(1);
});
