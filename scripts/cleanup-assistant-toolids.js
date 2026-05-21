#!/usr/bin/env node
/**
 * cleanup-assistant-toolids.js — fix Riley + Dialog Voicemail toolIds arrays
 * after the send_message_email recreation (2026-05-09):
 *   - REMOVE the dead reference `4e0f13e1-d6ce-4327-a0c5-2c7b452f2494` (the
 *     deleted code-type send_message_email) — Vapi's runtime fails the call
 *     with "couldn't get tool for hook" when it can't resolve a referenced
 *     tool ID.
 *   - ADD the new `c870432f-0b07-4228-915b-d02fa114c45c` (the apiRequest
 *     send_message_email) to Dialog Voicemail (Riley already has it).
 *
 * Read-then-PATCH so we never overwrite anything else on the assistant — only
 * the toolIds array changes.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/cleanup-assistant-toolids.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const DEAD_TOOL_ID = '4e0f13e1-d6ce-4327-a0c5-2c7b452f2494';
const NEW_SEND_MESSAGE_TOOL_ID = 'c870432f-0b07-4228-915b-d02fa114c45c';

const RILEY_ID    = '09a90334-1570-4db2-b336-31871b1eca8a';
const VOICEMAIL_ID = '9bd09c45-6c28-48eb-a0cd-2cdf3fdcd176';

const https = require('https');

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.vapi.ai',
      path,
      method,
      headers: {
        Authorization: 'Bearer ' + VAPI_KEY,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${path}: ${buf.slice(0, 300)}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad JSON: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fixAssistant(id, label, { addToolId } = {}) {
  console.log(`\n--- ${label} (${id}) ---`);
  const a = await api('GET', `/assistant/${id}`);
  const before = (a.model && a.model.toolIds) || [];
  let after = before.filter((t) => t !== DEAD_TOOL_ID);
  if (addToolId && !after.includes(addToolId)) after.push(addToolId);

  const removed = before.filter((t) => !after.includes(t));
  const added   = after.filter((t) => !before.includes(t));

  console.log(`  toolIds before (${before.length}):`, before.join(', ') || '(empty)');
  console.log(`  toolIds after  (${after.length}):`, after.join(', ') || '(empty)');
  if (!removed.length && !added.length) {
    console.log('  → no change needed, skipping PATCH');
    return;
  }
  console.log(`  removing: ${removed.join(', ') || '(none)'}`);
  console.log(`  adding:   ${added.join(', ')   || '(none)'}`);

  // PATCH — Vapi's assistant PATCH replaces the model object wholesale, so
  // send back the existing model with only toolIds changed.
  const newModel = { ...a.model, toolIds: after };
  await api('PATCH', `/assistant/${id}`, { model: newModel });
  console.log('  ✅ patched');
}

(async () => {
  try {
    await fixAssistant(RILEY_ID,    'Dialog Receptionist (Riley)');
    await fixAssistant(VOICEMAIL_ID, 'Dialog Voicemail', { addToolId: NEW_SEND_MESSAGE_TOOL_ID });
    console.log('\nDone. Re-run scripts/vapi-audit.js — should show zero "could not fetch" lines and send_message_email under both assistants.');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exit(1);
  }
})();
