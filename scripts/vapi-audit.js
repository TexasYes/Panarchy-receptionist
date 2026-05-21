#!/usr/bin/env node
/**
 * vapi-audit.js — read-only enumeration of Vapi assistants + tools to verify
 * which webhook entry points are configured + authenticated.
 *
 * Usage:
 *   VAPI_PRIVATE_KEY=<key> node scripts/vapi-audit.js
 *
 * Outputs a per-assistant + per-tool breakdown showing:
 *   - server.url (where Vapi POSTs)
 *   - whether auth is attached (legacy secret, credential ID, or static headers)
 *   - which entries point at our Railway webhook host
 *
 * Legend in output:
 *   ✓  points at our Railway webhook AND has auth attached
 *   ✗  points at our Railway webhook but NO auth — this is what you fix in Vapi
 *   ·  doesn't point at our webhook (Vapi-internal, static, or unrelated host)
 *
 * Read-only — never modifies anything in Vapi.
 */
const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) {
  console.error('ERROR: set VAPI_PRIVATE_KEY first.');
  console.error('  e.g.  VAPI_PRIVATE_KEY=$(railway variables get VAPI_PRIVATE_KEY) node scripts/vapi-audit.js');
  console.error('  or copy from Railway dashboard → Variables → VAPI_PRIVATE_KEY');
  process.exit(1);
}

const OUR_HOST = 'dialog-receptionist-webhook-production.up.railway.app';
const https = require('https');

function api(path) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'api.vapi.ai', path,
      headers: { Authorization: `Bearer ${VAPI_KEY}` },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} ${path}: ${buf.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`bad JSON from ${path}`)); }
      });
    }).on('error', reject);
  });
}

// Vapi tools store webhook config in two different shapes depending on type:
//   - `function` tools:   tool.server = { url, headers, credentialId, ... }
//   - `apiRequest` tools: tool.url, tool.method, tool.headers, tool.credentialId  (top-level, no `server`)
//   - `code` tools:       no server config (run inside Vapi)
//
// Normalize to a single { url, credentialId, ... } shape so the rest of the
// audit doesn't have to care which tool type it's looking at.
function effectiveServer(toolOrAssistant) {
  // Assistants always use the `server` shape
  if (toolOrAssistant.server) return toolOrAssistant.server;
  // apiRequest tools surface server config as top-level fields
  if (toolOrAssistant.type === 'apiRequest') {
    return {
      url:           toolOrAssistant.url,
      method:        toolOrAssistant.method,
      headers:       toolOrAssistant.headers,
      credentialId:  toolOrAssistant.credentialId,
      credentialIds: toolOrAssistant.credentialIds,
    };
  }
  return null;
}

function pointsAtUs(s) {
  return !!(s && s.url && s.url.includes(OUR_HOST));
}

// Vapi has migrated this several times; check every shape we know about.
function authStatus(s) {
  if (!s) return { has: false, label: '(no server config)' };
  const bits = [];
  if (s.secret) bits.push('legacy secret');
  if (s.credentialId) bits.push(`credentialId=${s.credentialId}`);
  if (Array.isArray(s.credentialIds) && s.credentialIds.length) {
    bits.push(`credentialIds=[${s.credentialIds.join(',')}]`);
  }
  if (s.headers && Object.keys(s.headers).length) {
    bits.push(`headers={${Object.keys(s.headers).join(',')}}`);
  }
  if (Array.isArray(s.credentials) && s.credentials.length) {
    bits.push(`credentials.length=${s.credentials.length}`);
  }
  return bits.length
    ? { has: true,  label: bits.join('; ') }
    : { has: false, label: 'NO AUTH ATTACHED' };
}

function flagFor(s) {
  if (!pointsAtUs(s)) return '·';
  return authStatus(s).has ? '✓' : '✗';
}

function shortPath(url) {
  if (!url) return '(none)';
  try { return new URL(url).pathname || url; } catch { return url; }
}

(async () => {
  // 1. List credentials so we can map credentialId → human name later.
  console.log('=== Credentials in account ===');
  let creds = [];
  try {
    creds = await api('/credential');
    if (!Array.isArray(creds) || creds.length === 0) {
      console.log('  (none — if you just created one, it may take a moment)');
    } else {
      for (const c of creds) {
        const name = c.name || c.label || '(unnamed)';
        const type = c.provider || c.type || '?';
        console.log(`  ${c.id}   ${type.padEnd(20)} ${name}`);
      }
    }
  } catch (e) {
    console.log('  (could not list credentials:', e.message + ')');
  }
  const credName = (id) => {
    const c = (creds || []).find((x) => x.id === id);
    return c ? (c.name || c.label || id) : id;
  };

  // 2. Walk every assistant.
  console.log('\n=== Assistants ===');
  const assistants = await api('/assistant');
  let fixCount = 0;
  const fixList = [];
  for (const a of (Array.isArray(assistants) ? assistants : [])) {
    const aServer = effectiveServer(a);
    const flag = flagFor(aServer);
    if (flag === '✗') { fixCount++; fixList.push(`assistant: ${a.name || a.id}`); }
    console.log(`\n${flag} ${a.name || '(unnamed)'}`);
    console.log(`    id:     ${a.id}`);
    console.log(`    server: ${aServer?.url || '(none)'}`);
    console.log(`    auth:   ${authStatus(aServer).label}`);

    // Inline tools defined on the assistant's model
    const inlineTools = (a.model && a.model.tools) || [];
    if (inlineTools.length) {
      console.log(`    inline tools (${inlineTools.length}):`);
      for (const t of inlineTools) {
        const tName = (t.function && t.function.name) || t.name || t.type || '(unnamed)';
        const tServer = effectiveServer(t);
        const tFlag = flagFor(tServer);
        if (tFlag === '✗') { fixCount++; fixList.push(`tool: ${a.name || a.id} → ${tName}`); }
        console.log(`      ${tFlag} ${tName}  (type=${t.type || '?'})`);
        console.log(`          server: ${shortPath(tServer?.url)}`);
        if (tServer?.url) console.log(`          auth:   ${authStatus(tServer).label}`);
      }
    }

    // Tool IDs referenced (separate Tool entities)
    const toolIds = (a.model && a.model.toolIds) || [];
    if (toolIds.length) {
      console.log(`    referenced tools (${toolIds.length}):`);
      for (const tid of toolIds) {
        try {
          const t = await api(`/tool/${tid}`);
          const tName = (t.function && t.function.name) || t.name || t.type || '(unnamed)';
          const tServer = effectiveServer(t);
          const tFlag = flagFor(tServer);
          if (tFlag === '✗') { fixCount++; fixList.push(`tool: ${a.name || a.id} → ${tName} (${tid})`); }
          console.log(`      ${tFlag} ${tName}  (type=${t.type || '?'})`);
          console.log(`          id:     ${tid}`);
          console.log(`          server: ${shortPath(tServer?.url)}`);
          if (tServer?.url) console.log(`          auth:   ${authStatus(tServer).label}`);
        } catch (e) {
          console.log(`      ? could not fetch tool ${tid}: ${e.message}`);
        }
      }
    }
  }

  // 3. Summary
  console.log('\n=== Summary ===');
  console.log(`Legend: ✓ = OK  |  ✗ = points at our webhook but NO auth  |  · = unrelated`);
  if (fixCount === 0) {
    console.log('\n✅ Everything pointing at our Railway webhook has auth attached.');
  } else {
    console.log(`\n❌ ${fixCount} place${fixCount === 1 ? '' : 's'} still need the credential attached:\n`);
    for (const f of fixList) console.log(`   • ${f}`);
    console.log('\nFor each: open it in the Vapi dashboard → Server / Server URL section');
    console.log('→ attach the same custom credential you used on Riley.');
  }
})().catch((e) => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
