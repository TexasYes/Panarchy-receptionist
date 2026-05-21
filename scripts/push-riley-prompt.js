#!/usr/bin/env node
/**
 * push-riley-prompt.js — push the canonical Riley system prompt from
 * `prompts/riley-system-prompt.md` to Vapi via API. Eliminates the
 * "did the manual paste stick?" failure mode.
 *
 * Strips the markdown header/preamble (everything up to and including the
 * first `---` separator line) so only the actual prompt body lands in Vapi.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/push-riley-prompt.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const RILEY_ID = '09a90334-1570-4db2-b336-31871b1eca8a';
const PROMPT_FILE = require('path').join(__dirname, '..', 'prompts', 'riley-system-prompt.md');

const fs = require('fs');
const https = require('https');

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.vapi.ai', path, method,
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

function extractPromptBody(markdownContent) {
  // Strip the file header/preamble (everything up to and including the first
  // standalone `---` separator). Keep everything after that as the prompt body.
  const lines = markdownContent.split('\n');
  const sepIdx = lines.findIndex((l) => l.trim() === '---');
  if (sepIdx === -1) {
    // No separator found — assume the whole file is the prompt body
    return markdownContent.trim();
  }
  return lines.slice(sepIdx + 1).join('\n').trim();
}

(async () => {
  try {
    const md = fs.readFileSync(PROMPT_FILE, 'utf8');
    const promptBody = extractPromptBody(md);
    console.log(`Source file:    ${PROMPT_FILE}`);
    console.log(`Prompt length:  ${promptBody.length} chars`);
    console.log(`First 100 chars: "${promptBody.slice(0, 100).replace(/\n/g, '\\n')}..."`);

    console.log('\n--- BEFORE: Riley\'s current prompt ---');
    const before = await api('GET', `/assistant/${RILEY_ID}`);
    const beforeMessages = (before.model && before.model.messages) || [];
    const beforeSys = beforeMessages.find((m) => m.role === 'system');
    console.log(`  current prompt length: ${beforeSys ? beforeSys.content.length : 0} chars`);
    if (beforeSys) {
      console.log(`  current first 100:     "${beforeSys.content.slice(0, 100).replace(/\n/g, '\\n')}..."`);
    }

    console.log('\n--- PATCHING ---');
    // Build new messages array — keep any non-system messages, replace/insert the system one.
    const newMessages = beforeMessages.filter((m) => m.role !== 'system');
    newMessages.unshift({ role: 'system', content: promptBody });
    const newModel = { ...before.model, messages: newMessages };
    await api('PATCH', `/assistant/${RILEY_ID}`, { model: newModel });
    console.log('  ✅ patched');

    console.log('\n--- AFTER: confirming ---');
    const after = await api('GET', `/assistant/${RILEY_ID}`);
    const afterMessages = (after.model && after.model.messages) || [];
    const afterSys = afterMessages.find((m) => m.role === 'system');
    console.log(`  new prompt length:     ${afterSys ? afterSys.content.length : 0} chars`);
    console.log(`  match expected length: ${afterSys && afterSys.content.length === promptBody.length ? 'YES ✅' : 'NO ❌'}`);
    console.log(`  contains "look that up" (should be FALSE if new prompt landed): ${afterSys && afterSys.content.toLowerCase().includes('never say any of these phrases') ? 'TRUE — new prompt is live' : 'old prompt still active'}`);
    console.log(`  contains TAKING A MESSAGE block:  ${afterSys && afterSys.content.includes('TAKING A MESSAGE') ? 'YES ✅' : 'NO ❌'}`);
    console.log(`  contains Caller ID block:         ${afterSys && afterSys.content.includes('Caller ID / callback number') ? 'YES ✅' : 'NO ❌'}`);
    console.log(`  contains Transfer rule block:     ${afterSys && afterSys.content.includes('Transfer rule') ? 'YES ✅' : 'NO ❌'}`);
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exit(1);
  }
})();
