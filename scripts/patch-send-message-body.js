#!/usr/bin/env node
/**
 * patch-send-message-body.js — set the `body` template on the send_message_email
 * apiRequest tool so the LLM-extracted parameters actually reach our /send-message
 * endpoint as the HTTP request body.
 *
 * Background: Vapi's `apiRequest` tool type requires BOTH:
 *   - function.parameters → schema for what the LLM extracts (set by previous patch)
 *   - body                → JSON-Schema template that maps extracted vars into the
 *                           outgoing HTTP body, using {{ varName }} placeholders
 *
 * Without `body`, Vapi sends an empty {} body even though the LLM extracted args.
 * Confirmed via the 2026-05-09 17:04 test call where toolCalls.arguments showed
 * the extracted values but our endpoint received `{}`.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/patch-send-message-body.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const TOOL_ID = 'c870432f-0b07-4228-915b-d02fa114c45c';

// Body template: each property declares a value that Vapi substitutes from the
// matching `function.parameters` extraction. The `{{ name }}` syntax mirrors
// Vapi's documented apiRequest placeholder format.
const body = {
  type: 'object',
  properties: {
    toEmail:       { type: 'string', value: '{{ toEmail }}' },
    toName:        { type: 'string', value: '{{ toName }}' },
    callerName:    { type: 'string', value: '{{ callerName }}' },
    callerCompany: { type: 'string', value: '{{ callerCompany }}' },
    callerNumber:  { type: 'string', value: '{{ callerNumber }}' },
    summary:       { type: 'string', value: '{{ summary }}' },
    details:       { type: 'string', value: '{{ details }}' },
    urgency:       { type: 'string', value: '{{ urgency }}' },
  },
};

const https = require('https');

function api(method, path, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : null;
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
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${path}: ${buf.slice(0, 400)}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad JSON: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  try {
    console.log('--- BEFORE ---');
    const before = await api('GET', `/tool/${TOOL_ID}`);
    console.log(`  function.name:               ${before.function?.name}`);
    console.log(`  function.parameters present: ${!!before.function?.parameters}`);
    console.log(`  body present:                ${!!before.body}  (${before.body ? 'has content' : 'NULL — this is the bug'})`);

    console.log('\n--- PATCHING body field ---');
    const after = await api('PATCH', `/tool/${TOOL_ID}`, { body });
    console.log('  ✅ patched');

    console.log('\n--- AFTER ---');
    console.log(`  body present:                ${!!after.body}`);
    console.log(`  body.properties:             ${Object.keys(after.body?.properties || {}).join(', ')}`);
    console.log(`  body.properties.toEmail:     ${JSON.stringify(after.body?.properties?.toEmail)}`);

    console.log('\nNext: make ONE test call. The /send-message Railway log line should now show toEmail=yes / consultant_email=yes (via toEmail mapping).');
    console.log('If args still arrive empty, the body-template format is wrong and we try a different shape.');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exit(1);
  }
})();
