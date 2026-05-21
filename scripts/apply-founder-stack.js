#!/usr/bin/env node
/**
 * apply-founder-stack.js — switch Riley to the Vapi-founder-recommended stack:
 *   - LLM:         OpenAI gpt-4.1   (chat completions; back off Realtime)
 *   - STT:         Deepgram         (unchanged from prior config)
 *   - TTS:         ElevenLabs v3    (newest, streams faster than v2)
 *
 * Background: 2026-05-09 testing on gpt-4o-realtime exposed turn-detection /
 * foreign-language failure modes that Realtime + complex multi-tool prompts
 * don't yet handle well. The Vapi founder personally recommended this stack
 * as the production-stable path. Email pipeline (send_message_email) is
 * already proven working under the chat-completions architecture (see
 * 16:55:37 call log).
 *
 * This script PATCHes Riley's `model`, `transcriber`, and `voice` fields
 * while preserving everything else (toolIds, messages, etc.). Always run
 * scripts/backup-assistants.js BEFORE this so we can roll back.
 *
 * Usage: VAPI_PRIVATE_KEY=<key> node scripts/apply-founder-stack.js
 */

const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) { console.error('ERROR: set VAPI_PRIVATE_KEY first.'); process.exit(1); }

const RILEY_ID = '09a90334-1570-4db2-b336-31871b1eca8a';

// ── TARGET STACK ──────────────────────────────────────────────────────────────
// We set provider+model only. voiceId is NOT set here — Vapi will use the
// provider's default if none was previously configured, OR preserve an
// existing voiceId if one is already on the assistant. Bob can pick a specific
// ElevenLabs voice in the Vapi dashboard (Voice tab → Voice dropdown) once
// the stack is live; common professional choices: Sarah, Rachel, Bella.
const TARGET_MODEL_PROVIDER       = 'openai';
const TARGET_MODEL                = 'gpt-4.1';
const TARGET_TRANSCRIBER_PROVIDER = 'deepgram';
const TARGET_VOICE_PROVIDER       = '11labs';      // Vapi's identifier for ElevenLabs
const TARGET_VOICE_MODEL          = 'eleven_v3';

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

    console.log('--- BEFORE ---');
    console.log(`  model.provider:       ${before.model?.provider || '(none)'}`);
    console.log(`  model.model:          ${before.model?.model || '(none)'}`);
    console.log(`  transcriber.provider: ${before.transcriber?.provider || '(none)'}`);
    console.log(`  transcriber.model:    ${before.transcriber?.model || '(none)'}`);
    console.log(`  voice.provider:       ${before.voice?.provider || '(none)'}`);
    console.log(`  voice.model:          ${before.voice?.model || '(none)'}`);
    console.log(`  voice.voiceId:        ${before.voice?.voiceId || '(none — will use provider default)'}`);

    // Build new config — preserve everything we don't explicitly change.
    const newModel       = { ...(before.model       || {}), provider: TARGET_MODEL_PROVIDER, model: TARGET_MODEL };
    const newTranscriber = { ...(before.transcriber || {}), provider: TARGET_TRANSCRIBER_PROVIDER };
    const newVoice       = { ...(before.voice       || {}), provider: TARGET_VOICE_PROVIDER, model: TARGET_VOICE_MODEL };

    console.log('\n--- PATCHING ---');
    await api('PATCH', `/assistant/${RILEY_ID}`, {
      model:       newModel,
      transcriber: newTranscriber,
      voice:       newVoice,
    });
    console.log('  ✅ patched');

    const after = await api('GET', `/assistant/${RILEY_ID}`);
    console.log('\n--- AFTER ---');
    console.log(`  model.provider:       ${after.model?.provider}`);
    console.log(`  model.model:          ${after.model?.model}`);
    console.log(`  transcriber.provider: ${after.transcriber?.provider}`);
    console.log(`  transcriber.model:    ${after.transcriber?.model || '(provider default)'}`);
    console.log(`  voice.provider:       ${after.voice?.provider}`);
    console.log(`  voice.model:          ${after.voice?.model}`);
    console.log(`  voice.voiceId:        ${after.voice?.voiceId || '(provider default — set in Vapi dashboard if you want a specific voice)'}`);
    console.log(`  prompt length:        ${(after.model?.messages || []).find(m => m.role === 'system')?.content?.length || 0} chars (preserved)`);
    console.log(`  toolIds count:        ${(after.model?.toolIds || []).length} (preserved)`);

    console.log('\nNext: open Vapi dashboard → Riley → Voice tab. Pick a specific ElevenLabs voice ID');
    console.log('(Sarah, Rachel, and Bella are common professional choices). If voiceId is set above, you can skip.');
    console.log('\nThen test call. If conversational rhythm is good, we are done.');
  } catch (e) {
    console.error('\nFAILED:', e.message);
    process.exit(1);
  }
})();
