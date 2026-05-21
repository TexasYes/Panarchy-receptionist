#!/usr/bin/env node
/**
 * restore-riley-model.js — set Riley's model back to `gpt-4o` (chat completions
 * + TTS pipeline) from `gpt-4o-realtime-preview-2024-12-17`.
 *
 * Realtime API doesn't handle our complex prompt + tool flow well — confirmed
 * by the 2026-05-09 17:26 disaster call where Riley spoke a foreign language
 * and cut the caller off. The 16:55 successful call used gpt-4o.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/restore-riley-model.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const RILEY_ID = '09a90334-1570-4db2-b336-31871b1eca8a';
const TARGET_MODEL = 'gpt-4o';

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

(async () => {
  try {
    const before = await api('GET', `/assistant/${RILEY_ID}`);
    console.log(`BEFORE  model.provider: ${before.model?.provider}`);
    console.log(`BEFORE  model.model:    ${before.model?.model}`);

    if (before.model?.model === TARGET_MODEL) {
      console.log(`\nAlready on ${TARGET_MODEL} — nothing to do.`);
      return;
    }

    const newModel = { ...before.model, model: TARGET_MODEL };
    await api('PATCH', `/assistant/${RILEY_ID}`, { model: newModel });
    console.log('\n✅ Patched.');

    const after = await api('GET', `/assistant/${RILEY_ID}`);
    console.log(`AFTER   model.provider: ${after.model?.provider}`);
    console.log(`AFTER   model.model:    ${after.model?.model}`);
    console.log(`AFTER   prompt length:  ${(after.model?.messages || []).find(m => m.role === 'system')?.content?.length || 0}`);
    console.log(`AFTER   toolIds count:  ${(after.model?.toolIds || []).length}`);
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
