#!/usr/bin/env node
/**
 * patch-send-message-tool.js — one-shot patch for the Vapi `send_message_email`
 * apiRequest tool (id `c870432f-0b07-4228-915b-d02fa114c45c`).
 *
 * Vapi's dashboard UI for `apiRequest` tools doesn't currently expose:
 *   - function.name           (defaults to `api_request_tool` — Riley's prompt won't find it)
 *   - function.parameters     (the schema the LLM uses to extract args from conversation)
 *   - variableExtractionPlan.schema (response shape so Riley reasons about success/failure)
 *
 * This script PATCHes them via Vapi's REST API. Read-only on everything else
 * (URL, method, credentialId, server config — all preserved).
 *
 * Usage:
 *   VAPI_PRIVATE_KEY=<key> node scripts/patch-send-message-tool.js
 *
 * Verify after running:
 *   VAPI_PRIVATE_KEY=<key> node scripts/vapi-audit.js | grep -A4 send_message
 */

const TOOL_ID = 'c870432f-0b07-4228-915b-d02fa114c45c';
const VAPI_KEY = process.env.VAPI_PRIVATE_KEY;
if (!VAPI_KEY) {
  console.error('ERROR: set VAPI_PRIVATE_KEY first.');
  process.exit(1);
}

const patch = {
  function: {
    name: 'send_message_email',
    description:
      "Email a message from a caller to the consultant they were trying to reach. " +
      "Call this AFTER you have collected the caller's name, company, callback " +
      "number, and reason — and only after lookup_employee_email has returned the " +
      "consultant's email. Wait for success: true before confirming delivery to the caller.",
    parameters: {
      type: 'object',
      properties: {
        toEmail:       { type: 'string', description: "Consultant's email address — must come from lookup_employee_email's response, not invented" },
        toName:        { type: 'string', description: "Consultant's full name (e.g. 'Henry Durham')" },
        callerName:    { type: 'string', description: "Caller's full name (first + last)" },
        callerCompany: { type: 'string', description: "Caller's company name" },
        callerNumber:  { type: 'string', description: "Caller's callback number in E.164 format if possible (e.g. +15125551234)" },
        summary:       { type: 'string', description: "ONE-sentence topic of the call — becomes the email subject" },
        details:       { type: 'string', description: "Longer narrative of what the caller said — becomes the Call Summary box in the email body" },
        urgency:       { type: 'string', description: "Optional urgency or timing (e.g. 'today if possible', 'no rush')" },
      },
      required: ['toEmail', 'toName', 'callerName', 'callerCompany', 'callerNumber', 'summary'],
    },
  },
  variableExtractionPlan: {
    schema: {
      type: 'object',
      properties: {
        success:  { type: 'boolean', description: 'True if email was sent successfully — Riley should ONLY confirm delivery when this is true' },
        message:  { type: 'string',  description: 'Human-readable confirmation message' },
        toEmail:  { type: 'string',  description: 'Email address the message was delivered to' },
        fromUser: { type: 'string',  description: 'Sender email (receptionist@dialoggroup.com)' },
        subject:  { type: 'string',  description: 'Subject line used for the email' },
        error:    { type: 'string',  description: 'Error description if success is false' },
      },
    },
  },
};

const https = require('https');
const data = JSON.stringify(patch);
const req = https.request(
  {
    hostname: 'api.vapi.ai',
    path: '/tool/' + TOOL_ID,
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + VAPI_KEY,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  },
  (res) => {
    let buf = '';
    res.on('data', (c) => (buf += c));
    res.on('end', () => {
      if (res.statusCode >= 400) {
        console.error(`FAIL HTTP ${res.statusCode}:`, buf);
        process.exit(1);
      }
      try {
        const j = JSON.parse(buf);
        console.log('✅ Patched tool', TOOL_ID);
        console.log('   function.name:                          ', j.function?.name);
        console.log('   function.parameters present:            ', !!j.function?.parameters);
        console.log('   function.parameters.required:           ', (j.function?.parameters?.required || []).join(', '));
        console.log('   variableExtractionPlan.schema present:  ', !!j.variableExtractionPlan?.schema);
        console.log('   response fields:                        ', Object.keys(j.variableExtractionPlan?.schema?.properties || {}).join(', '));
        console.log('\nNext: re-attach this tool to Riley + Dialog Voicemail (if not already), then test call.');
      } catch (e) {
        console.error('Could not parse Vapi response:', e.message, buf.slice(0, 300));
        process.exit(1);
      }
    });
  }
);
req.on('error', (e) => {
  console.error('Network error:', e.message);
  process.exit(1);
});
req.write(data);
req.end();
