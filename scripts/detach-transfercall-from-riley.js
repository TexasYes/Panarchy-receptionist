#!/usr/bin/env node
/**
 * detach-transfercall-from-riley.js — remove the Vapi-native `transferCall`
 * tool (id `a8393170-b57e-428e-b282-500e2258f8ab`) from Riley's toolIds list.
 *
 * Why: Riley has BOTH `transferCall` (Vapi-native, static-destinations,
 * no-screening) AND `warm_transfer_consult` (POSTs to /transfer-destination,
 * routes through the screener with accept/reject). She was picking the static
 * one for every transfer, bypassing the screener entirely. This script
 * forces her to use warm_transfer_consult by removing the legacy option.
 *
 * Always run scripts/backup-assistants.js BEFORE this so we can recover.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/detach-transfercall-from-riley.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const RILEY_ID         = '09a90334-1570-4db2-b336-31871b1eca8a';
const TRANSFERCALL_ID  = 'a8393170-b57e-428e-b282-500e2258f8ab';

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

(async () => {
  try {
    const a = await api('GET', `/assistant/${RILEY_ID}`);
    const before = (a.model && a.model.toolIds) || [];
    const after = before.filter((t) => t !== TRANSFERCALL_ID);

    console.log(`Riley toolIds before (${before.length}):`, before.join(', '));
    console.log(`Riley toolIds after  (${after.length}):`, after.join(', '));

    if (after.length === before.length) {
      console.log('\ntransferCall not found in Riley\'s toolIds — nothing to do.');
      return;
    }

    const newModel = { ...a.model, toolIds: after };
    await api('PATCH', `/assistant/${RILEY_ID}`, { model: newModel });
    console.log('\n✅ Detached transferCall from Riley.');
    console.log('   She must now use warm_transfer_consult (which routes through the screener).');
    console.log('\nVerify: VAPI_PRIVATE_KEY=<key> node scripts/vapi-audit.js | grep -A2 -E "Riley|transferCall|warm_transfer"');
  } catch (e) {
    console.error('FAILED:', e.message);
    process.exit(1);
  }
})();
