#!/usr/bin/env node
/**
 * backup-assistants.js — snapshot every Vapi assistant to backups/
 *   - Full assistant JSON (everything Vapi returns) → backups/<name>-<date>.json
 *   - System prompt extracted to readable markdown    → backups/<name>-<date>.md
 *
 * Run BEFORE any cleanup/patch script that touches assistants. The 2026-05-09
 * lost-prompt scare wouldn't have happened if we'd had this.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/backup-assistants.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const fs = require('fs');
const path = require('path');
const https = require('https');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

function api(path) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.vapi.ai', path,
      headers: { Authorization: 'Bearer ' + VAPI_KEY },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${path}: ${buf.slice(0, 200)}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad JSON from ' + path)); }
      });
    }).on('error', reject);
  });
}

function safeFilename(s) {
  return String(s || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function extractSystemPrompt(assistant) {
  const messages = (assistant.model && assistant.model.messages) || [];
  const sys = messages.find((m) => m.role === 'system');
  return sys ? sys.content : '';
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-05-09T15-49-32
  console.log(`Backup timestamp: ${stamp}`);
  console.log(`Output dir: ${BACKUP_DIR}\n`);

  const assistants = await api('/assistant');
  for (const a of (Array.isArray(assistants) ? assistants : [])) {
    const slug = safeFilename(a.name || a.id);
    const jsonFile  = path.join(BACKUP_DIR, `${slug}-${stamp}.json`);
    const promptFile = path.join(BACKUP_DIR, `${slug}-${stamp}.md`);

    fs.writeFileSync(jsonFile, JSON.stringify(a, null, 2));

    const prompt = extractSystemPrompt(a);
    const promptMd = [
      `# ${a.name || '(unnamed)'} — system prompt snapshot`,
      ``,
      `- Assistant ID: \`${a.id}\``,
      `- Snapshot:    ${stamp}`,
      `- First message: ${(a.firstMessage || '(none)').slice(0, 200)}`,
      ``,
      `---`,
      ``,
      prompt || '(no system message found in model.messages)',
    ].join('\n');
    fs.writeFileSync(promptFile, promptMd);

    console.log(`  ${a.name || a.id}`);
    console.log(`    → ${path.basename(jsonFile)}  (${fs.statSync(jsonFile).size} bytes)`);
    console.log(`    → ${path.basename(promptFile)}  (${prompt ? `${prompt.length} chars of prompt` : 'EMPTY PROMPT — investigate'})`);
  }

  console.log(`\nDone. ${BACKUP_DIR}/ now has fresh snapshots.`);
  console.log(`Tip: commit the latest snapshots when you do major prompt changes — git history becomes your audit trail.`);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
