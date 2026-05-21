/**
 * Panarchy AI Receptionist — Webhook Server
 *
 * Cloned from dialog-receptionist 2026-05-21. Same code, different env values.
 *
 * Endpoints:
 *   GET  /health                  — health check
 *   GET  /employees               — list all employees from Google Sheet
 *   POST /lookup-client           — HubSpot VIP client lookup (unused by current Bland flow)
 *   POST /transfer-destination    — Vapi transfer destination lookup (legacy)
 *
 * Environment variables required:
 *   GOOGLE_API_KEY                — Google Cloud API key (read access to GOOGLE_SHEET_ID)
 *   GOOGLE_SHEET_ID               — Google Sheet ID for Panarchy employee directory
 *   MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET — Microsoft Graph creds (panarchy.io tenant)
 *   MS_SENDER_EMAIL               — defaults to receptionist@panarchy.io
 *   ADMIN_API_KEY                 — bearer token for /employees, /daily-summary
 *   BLAND_API_KEY                 — for the daily summary cron
 *   PORT                          — (optional) port, defaults to 3000
 */

const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const cron = require('node-cron');
const { google } = require('googleapis');
const app = express();
app.use(express.json({ limit: '2mb' })); // Vapi artifact.messages payloads can be >100kb
app.set('trust proxy', 1);                // Railway sits behind a proxy; needed for accurate req.ip in logs

// ── VAPI RESPONSE HELPER ──────────────────────────────────────────────────────
// Handles both Vapi webhook format and plain JSON for direct testing.
// If called from Vapi (toolCallId present), wraps in Vapi's expected format.
// If called directly (e.g. curl test), returns plain JSON.
function makeResponder(req, res) {
  const toolCallId =
       req.body?.message?.toolCallList?.[0]?.id
    || req.body?.message?.toolCalls?.[0]?.id
    || req.body?.message?.toolWithToolCallList?.[0]?.toolCall?.id
    || req.body?.toolCallId
    || req.body?.toolCall?.id
    || null;
  const isVapi = !!toolCallId;

  // Extract args — Vapi's tool-call envelope has shifted across versions and
  // tool types (function vs apiRequest). Try every known location.
  function extractArgs() {
    const candidates = [
      req.body?.message?.toolCallList?.[0]?.function?.arguments,
      req.body?.message?.toolCalls?.[0]?.function?.arguments,
      req.body?.message?.toolWithToolCallList?.[0]?.toolCall?.function?.arguments,
      req.body?.toolCall?.function?.arguments,
      req.body?.message?.functionCall?.parameters,  // legacy shape
      req.body?.message?.functionCall?.arguments,
      req.body?.arguments,
      req.body?.params,
    ];
    for (const raw of candidates) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === 'object') return raw;             // already parsed
      if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch(e) {}        // parse string
      }
    }
    // Fallback: top-level body (apiRequest tools / direct curl test send args here)
    return req.body || {};
  }

  return {
    send: (result) => isVapi
      ? res.json({ results: [{ toolCallId, result }] })
      : res.json(result),
    args: extractArgs(),
  };
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
const HUBSPOT_API_KEY     = process.env.HUBSPOT_API_KEY;
const PORT                = process.env.PORT || 3000;
const SHEET_ID            = process.env.GOOGLE_SHEET_ID || '1iPluCrn4fVbjtuQKJdLz0lj89WfHW-b4uv2yBfablH8';
const SHEET_RANGE         = 'Sheet1!A:F'; // name, phone, email, conditions, gender (+ any future columns)
const VAPI_SERVER_SECRET  = process.env.VAPI_SERVER_SECRET || '';  // shared secret set in Vapi dashboard
const ADMIN_API_KEY       = process.env.ADMIN_API_KEY || '';       // bearer token for /employees etc.

// ── BRAND (used in email templates) ───────────────────────────────────────────
// Defaults match the Panarchy 2022 brand guidelines (docs/Panarchy_Brand_Guidelines.md):
// Black background + Red accent. Override in Railway env if the brand evolves.
const COMPANY_NAME        = process.env.COMPANY_NAME    || 'Panarchy';
const BRAND_PRIMARY       = process.env.BRAND_PRIMARY   || '#000000'; // header background (Panarchy Black)
const BRAND_ACCENT        = process.env.BRAND_ACCENT    || '#EF4124'; // accent bar / link colour (Panarchy Red)

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────
// Both middlewares fail OPEN when their env var is unset (logging a loud warning
// on every request) so the server keeps working between deploy and the moment
// you set the env var in Railway + Vapi. Once the var is set, requests without
// the secret are rejected. Comparison is timing-safe.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireVapiSecret(req, res, next) {
  if (!VAPI_SERVER_SECRET) {
    console.warn(`[AUTH] VAPI_SERVER_SECRET not set — allowing ${req.method} ${req.path} from ${req.ip} (INSECURE)`);
    return next();
  }
  // Vapi's credential UI lets you choose the header. Accept all three common
  // shapes so we don't break if someone reconfigures the credential type:
  //   1. x-vapi-secret: <token>            (Custom Header style)
  //   2. Authorization: <token>            (Bearer Token, prefix disabled)
  //   3. Authorization: Bearer <token>     (Bearer Token, prefix enabled)
  const xvs       = req.get('x-vapi-secret') || '';
  const authRaw   = req.get('authorization') || '';
  const authToken = authRaw.replace(/^Bearer\s+/i, '');
  if (safeEqual(xvs, VAPI_SERVER_SECRET) || safeEqual(authToken, VAPI_SERVER_SECRET)) {
    return next();
  }
  // Log which header(s) showed up so debugging mismatches is fast — never log
  // the actual values.
  const sawXvs  = xvs ? 'yes' : 'no';
  const sawAuth = authRaw ? 'yes' : 'no';
  console.warn(`[AUTH] Rejected ${req.method} ${req.path} from ${req.ip} — bad/missing secret (x-vapi-secret=${sawXvs}, authorization=${sawAuth})`);
  return res.status(401).json({ error: 'Unauthorized' });
}

function requireAdminKey(req, res, next) {
  if (!ADMIN_API_KEY) {
    console.warn(`[AUTH] ADMIN_API_KEY not set — allowing ${req.method} ${req.path} from ${req.ip} (INSECURE)`);
    return next();
  }
  const auth = req.get('authorization') || '';
  const provided = auth.replace(/^Bearer\s+/i, '') || req.get('x-api-key') || '';
  if (!safeEqual(provided, ADMIN_API_KEY)) {
    console.warn(`[AUTH] Rejected ${req.method} ${req.path} from ${req.ip} — bad/missing admin key`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── GOOGLE SHEETS AUTH ────────────────────────────────────────────────────────
// Uses API key auth — sheet must be shared as "Anyone with the link can view"
function getGoogleAuth() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.warn('GOOGLE_API_KEY not set — employee directory will use fallback');
    return null;
  }
  return apiKey; // returned as string, used directly in sheets API call
}

// ── PHONE NORMALIZATION ───────────────────────────────────────────────────────
// Google Sheet rows can have phones in any format: "(512) 413-3938",
// "1-512-413-3938", "5124133938", "+15124133938" etc. Twilio/Vapi need E.164
// (`+<countrycode><number>`). Normalize on the way out of the sheet so a sheet
// typo can't break outbound dialing or warm transfers.
function normalizePhone(raw) {
  if (!raw) return '';
  const cleaned = String(raw).trim().replace(/[^+\d]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  // 10 digits → assume US, prepend +1
  if (cleaned.length === 10) return `+1${cleaned}`;
  // 11 digits starting with 1 → US country code present, just add +
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  // Anything else: prepend + and warn (probably wrong but keeps the row usable)
  console.warn(`normalizePhone: unusual digit count (${cleaned.length}) for "${raw}" → "+${cleaned}"`);
  return `+${cleaned}`;
}

// ── EMPLOYEE DIRECTORY (Google Sheet) ─────────────────────────────────────────
// Cache the sheet data for 60 seconds to avoid hitting the API on every call.
let employeeCache = null;
let employeeCacheTime = 0;
const CACHE_TTL_MS = 60 * 1000;

async function getEmployeeDirectory() {
  const now = Date.now();
  if (employeeCache && (now - employeeCacheTime) < CACHE_TTL_MS) {
    return employeeCache;
  }

  const apiKey = getGoogleAuth();
  if (!apiKey) return FALLBACK_EMPLOYEES;

  try {
    const sheets = google.sheets({ version: 'v4' });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
      key: apiKey,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return FALLBACK_EMPLOYEES;

    // First row is headers: #, name, phone, gender, email, conditions
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const nameIdx   = headers.indexOf('name');
    const phoneIdx  = headers.indexOf('phone');
    const emailIdx  = headers.indexOf('email');
    const condIdx   = headers.indexOf('conditions');
    const genderIdx = headers.indexOf('gender');
    // Note: '#' column (row number) is ignored

    const employees = rows.slice(1)
      .filter(row => row[nameIdx] && row[phoneIdx])
      .map(row => {
        const name       = (row[nameIdx]    || '').trim();
        const phone      = normalizePhone(row[phoneIdx]);
        const email      = (row[emailIdx]   || '').trim();
        const conditions = condIdx   >= 0 ? (row[condIdx]   || '').trim() : '';
        const gender     = genderIdx >= 0 ? (row[genderIdx] || '').trim().toLowerCase() : '';
        // Derive aliases from conditions column if present, otherwise use first/last name
        let aliases = [];
        if (conditions) {
          // Extract names from condition text like "Caller asks for Bob Gutermuth or Bob by name"
          const orParts = conditions.replace(/caller asks for /gi, '').replace(/ by name/gi, '').split(' or ');
          aliases = orParts.map(p => p.trim()).filter(Boolean);
        }
        if (aliases.length === 0) {
          const parts = name.split(' ');
          aliases = [parts[0]];
          if (parts.length > 1) aliases.push(parts[parts.length - 1]);
        }
        return { name, phone, email, conditions, gender, aliases };
      });

    console.log(`Loaded ${employees.length} employees from Google Sheet`);
    employeeCache     = employees;
    employeeCacheTime = now;
    return employees;

  } catch (err) {
    console.error('Google Sheets error:', err.message);
    return employeeCache || FALLBACK_EMPLOYEES;
  }
}

// ── FALLBACK EMPLOYEE LIST (used if Google Sheets is unreachable) ──────────────
// Panarchy directory as of 2026-05-21. Phones are TBD — provide them in the
// Google Sheet (preferred) or fill in below. `gender` is optional and unused
// outside Riley's prompt pronouns; leave it off when unknown.
const FALLBACK_EMPLOYEES = [
  { name: "Bob Gutermuth",   aliases: ["Bob"],     phone: "+15129255665", email: "bobgutermuth@panarchy.io" },
  { name: "Vince DiBianca",  aliases: ["Vince"],   phone: "+16093061155", email: "vincedibianca@panarchy.io" },
  { name: "Mark Thompson",   aliases: ["Mark"],    phone: "+15129684381", email: "MarkThompson@panarchy.io" },
  { name: "Colleen Brown",   aliases: ["Colleen"], phone: "+12063910085", email: "ColleenBrown@panarchy.io" },
  { name: "Rhonda Bradford", aliases: ["Rhonda"],  phone: "",             email: "RhondaBradford@panarchy.io" }, // TODO: add Rhonda's phone
];

// ── EMPLOYEE LOOKUP HELPER ─────────────────────────────────────────────────────
function findEmployee(employees, requestedName) {
  if (!requestedName) return null;
  const q = requestedName.toLowerCase().trim();
  return employees.find(emp => {
    if (emp.name.toLowerCase() === q) return true;
    if (emp.name.toLowerCase().includes(q)) return true;
    if (q.includes(emp.name.toLowerCase())) return true;
    return (emp.aliases || []).some(a =>
      a.toLowerCase() === q ||
      a.toLowerCase().includes(q) ||
      q.includes(a.toLowerCase())
    );
  }) || null;
}

// ── VIP CLIENT LIST (fallback + priority tier) ────────────────────────────────
// Panarchy has no VIP list at launch (2026-05-21). Add company names here when
// we want HubSpot-style priority recognition. The current Bland Riley flow does
// not call /lookup-client, so this list is dormant either way.
const VIP_CLIENTS = [];

// ── HELPERS ───────────────────────────────────────────────────────────────────

// ── HUBSPOT CACHE ────────────────────────────────────────────────────────────
// Cache HubSpot company lookups for 24 hours to reduce API calls.
// VIP list is always checked first (instant, no cache needed).
let hubspotCache = {};           // keyed by normalized company name
let hubspotCacheTime = 0;
const HUBSPOT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCachedHubspot(normalizedName) {
  const now = Date.now();
  if ((now - hubspotCacheTime) > HUBSPOT_CACHE_TTL) {
    hubspotCache = {}; // expire entire cache after 24hrs
    hubspotCacheTime = now;
  }
  return hubspotCache[normalizedName] || null;
}

function setCachedHubspot(normalizedName, result) {
  hubspotCache[normalizedName] = result;
}

/**
 * Normalize a company name for fuzzy matching.
 * Strips legal suffixes, punctuation, extra spaces.
 */
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|group|partners|associates|consulting|solutions|services|&|and)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two company names are likely the same.
 * Simple substring match after normalization — works well for 20-200 names.
 */
function companiesMatch(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Check the VIP list first (no API call needed).
 */
function checkVipList(companyName) {
  return VIP_CLIENTS.find(vip => companiesMatch(vip, companyName)) || null;
}

/**
 * Search HubSpot Companies API for a matching company.
 * Uses the v3 search endpoint with a name filter.
 */
async function searchHubSpot(companyName) {
  if (!HUBSPOT_API_KEY) {
    console.warn('HUBSPOT_API_KEY not set — skipping HubSpot lookup');
    return null;
  }

  // Check cache first
  const cacheKey = normalize(companyName);
  const cached = getCachedHubspot(cacheKey);
  if (cached !== null) {
    console.log(`HubSpot cache hit: "${companyName}"`);
    return cached;
  }

  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/companies/search',
      {
        filterGroups: [{
          filters: [{
            propertyName: 'name',
            operator: 'CONTAINS_TOKEN',
            value: normalize(companyName).split(' ')[0], // Search by first meaningful word
          }]
        }],
        properties: ['name', 'hs_lead_status', 'lifecyclestage', 'hubspot_owner_id'],
        limit: 10,
      },
      {
        headers: {
          'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 3000, // 3s timeout — don't slow down the call
      }
    );

    const results = response.data.results || [];

    // Find the best match among results
    const match = results.find(r =>
      companiesMatch(r.properties.name || '', companyName)
    );

    const result = match ? {
      hubspotId: match.id,
      name: match.properties.name,
      lifecyclestage: match.properties.lifecyclestage,
      leadStatus: match.properties.hs_lead_status,
      ownerId: match.properties.hubspot_owner_id,
    } : null;

    setCachedHubspot(cacheKey, result);
    return result;

  } catch (err) {
    console.error('HubSpot API error:', err.message);
    return null; // Fail open — don't block the call if HubSpot is down
  }
}

// ── MAIN ENDPOINT ─────────────────────────────────────────────────────────────
/**
 * POST /lookup-client
 *
 * Called by ElevenLabs agent tool during a live call.
 *
 * Request body:
 *   { "company_name": "Acme Corporation", "caller_name": "John Smith" }
 *
 * Response:
 *   {
 *     "is_client": true,
 *     "is_vip": true,
 *     "matched_name": "Acme Corp",
 *     "treatment": "vip" | "standard_client" | "unknown",
 *     "message_to_agent": "This is a VIP client. Skip screening. Transfer immediately with priority flag."
 *   }
 */
app.post('/lookup-client', requireVapiSecret, async (req, res) => {
  const { send: respond, args } = makeResponder(req, res);
  const { company_name, caller_name } = args;

  if (!company_name) {
    return respond({
      is_client: false,
      is_vip: false,
      treatment: 'unknown',
      message_to_agent: 'No company name provided. Proceed with standard screening.',
    });
  }

  // 1. Check VIP list first (instant, no API call)
  const vipMatch = checkVipList(company_name);
  if (vipMatch) {
    console.log(`VIP match: "${company_name}" → "${vipMatch}"`);
    return respond({
      is_client: true,
      is_vip: true,
      matched_name: vipMatch,
      treatment: 'vip',
      message_to_agent: `PRIORITY CLIENT: ${vipMatch}. Skip all screening. Transfer immediately. Flag as priority on handoff brief.`,
    });
  }

  // 2. Check HubSpot
  const hubspotResult = await searchHubSpot(company_name);

  if (hubspotResult) {
    const isActiveClient = ['customer', 'evangelist'].includes(
      (hubspotResult.lifecyclestage || '').toLowerCase()
    );

    if (isActiveClient) {
      console.log(`HubSpot client match: "${company_name}" → "${hubspotResult.name}"`);
      return respond({
        is_client: true,
        is_vip: false,
        matched_name: hubspotResult.name,
        hubspot_id: hubspotResult.hubspotId,
        treatment: 'standard_client',
        message_to_agent: `Known client: ${hubspotResult.name}. Proceed with warm transfer. No need for extensive screening.`,
      });
    }

    console.log(`HubSpot non-client match: "${company_name}" → "${hubspotResult.name}" (${hubspotResult.lifecyclestage})`);
    return respond({
      is_client: false,
      is_vip: false,
      matched_name: hubspotResult.name,
      hubspot_id: hubspotResult.hubspotId,
      treatment: 'prospect',
      message_to_agent: `Known prospect/lead: ${hubspotResult.name}. Apply standard screening but handle professionally.`,
    });
  }

  // 3. Not found anywhere
  console.log(`No match found for: "${company_name}"`);
  return respond({
    is_client: false,
    is_vip: false,
    treatment: 'unknown',
    message_to_agent: 'Company not found in client database. Apply full screening protocol.',
  });
});

// Employee directory is now loaded from Google Sheet (see getEmployeeDirectory above)

// ── PRONOUN HELPER ───────────────────────────────────────────────────────────
function getPronoun(gender) {
  const g = (gender || '').toLowerCase().trim();
  if (g === 'female' || g === 'she' || g === 'her') return 'she';
  if (g === 'male'   || g === 'he'  || g === 'him') return 'he';
  return 'they';
}

// ── VAPI TRANSFER DESTINATION ─────────────────────────────────────────────────
/**
 * Vapi calls this when it needs a transfer destination.
 * Uses Riley's exact patch — extracts employee from call context in priority order:
 *   1. Latest lookup_employee tool result in artifact.messages
 *   2. Recent conversation text matched against hardcoded directory
 *   3. Transcript scan
 */
app.post('/transfer-destination', requireVapiSecret, (req, res) => {
  try {
    const body = req.body || {};

    // Concise log — the previous full JSON.stringify pretty-print blew through
    // Railway's 500-logs/sec quota whenever an `artifact.messages` array was
    // large, causing dropped log lines (including ones we needed to debug
    // /send-message). Set DEBUG_TRANSFER=1 in env to re-enable the full dump.
    const callId = body.message?.call?.id || body.call?.id || 'unknown';
    const msgCount = (body.message?.call?.artifact?.messages || body.call?.artifact?.messages || body.message?.messages || body.messages || []).length;
    console.log(`/transfer-destination called: callId=${callId}, ${msgCount} prior messages`);
    if (process.env.DEBUG_TRANSFER === '1') {
      console.log('=== TRANSFER-DESTINATION REQUEST (DEBUG) ===');
      console.log(JSON.stringify(body, null, 2));
      console.log('=== END TRANSFER-DESTINATION REQUEST ===');
    }

    // --- 1) Directory map (server-side source of truth) ---
    const DIRECTORY = {
      "becky beane":          { phone: "+15122977222" },
      "bob gutermuth":        { phone: "+15129255665" },
      "cherie cox":           { phone: "+15124330333" },
      "david martino":        { phone: "+15124998129" },
      "dominic clark":        { phone: "+14632076859" },
      "emily wilson":         { phone: "+13035528043" },
      "heather waisman":      { phone: "+19044802869" },
      "henry durham":         { phone: "+15124133938" },
      "karen james":          { phone: "+15126261825" },
      "katerina tsasis":      { phone: "+15122940786" },
      "kris hardy":           { phone: "+15126990327" },
      "lacey aleman":         { phone: "+15125858122" },
      "mark thompson":        { phone: "+15129684381" },
      "mel maldonado-turner": { phone: "+15126326097" },
      "merri lee barton":     { phone: "+18015589918" },
      "sam frost":            { phone: "+17372100884" },
      "sean dineen":          { phone: "+15126197409" },
      "valerie hausladen":    { phone: "+13035470323" },
      "yvonne bourquin":      { phone: "+12817979963" },
    };

    const normName = (s) =>
      String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

    const parsePossiblyJson = (x) => {
      if (x == null) return null;
      if (typeof x === "object") return x;
      if (typeof x === "string") {
        try { return JSON.parse(x); } catch { return null; }
      }
      return null;
    };

    // --- 2) Pull call + messages from common Vapi shapes ---
    const msg = body.message || body;
    const call = msg.call || body.call || {};
    const artifact = call.artifact || {};
    const messages =
      artifact.messages ||
      call.messages ||
      msg.messages ||
      [];

    // --- 3) Try most recent lookup_employee tool result ---
    let employeeFullName = null;
    let employeePhone = null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const toolName = m?.name || m?.toolName;
      const role = m?.role;

      const isLookupEmployeeResult =
        toolName === "lookup_employee" ||
        (role === "tool" && m?.name === "lookup_employee");

      if (!isLookupEmployeeResult) continue;

      const resultObj = parsePossiblyJson(m.result) || parsePossiblyJson(m.content);
      if (resultObj && resultObj.found && (resultObj.phone || resultObj.name)) {
        employeeFullName = resultObj.name ? normName(resultObj.name) : null;
        const rawPhone = String(resultObj.phone || "");
        if (rawPhone) {
          employeePhone = rawPhone.startsWith("+") ? rawPhone : `+${rawPhone}`;
        }
      }
      if (employeePhone) break;
    }

    // --- 4) Infer from recent conversation using DIRECTORY ---
    if (!employeePhone) {
      const recentText = messages
        .slice(-12)
        .map((m) => (m.message || m.content || m.transcript || ""))
        .join(" ")
        .toLowerCase();

      const dirNames = Object.keys(DIRECTORY);
      const matched = dirNames.find((n) => recentText.includes(n));
      if (matched) {
        employeeFullName = matched;
        employeePhone = DIRECTORY[matched].phone;
      }
    }

    // --- 5) Final fallback: transcript scan ---
    if (!employeePhone) {
      const transcript = String(artifact.transcript || call.transcript || "");
      const t = transcript.toLowerCase();
      const dirNames = Object.keys(DIRECTORY);
      const matched = dirNames.find((n) => t.includes(n));
      if (matched) {
        employeeFullName = matched;
        employeePhone = DIRECTORY[matched].phone;
      }
    }

    if (!employeePhone) {
      console.warn('Transfer destination: no employee phone found');
      res.set("Content-Type", "application/json");
      return res.status(200).send(JSON.stringify({ error: "No employee phone found" }));
    }

    console.log(`Transfer destination: ${employeeFullName} → ${employeePhone}`);

    // --- 6) Warm transfer response ---
    const responsePayload = {
      destination: {
        type: "number",
        number: employeePhone
      },
      transferPlan: {
        mode: "warm-transfer-say-summary",
        summaryPlan: { enabled: true }
      }
    };

    res.set("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify(responsePayload));

  } catch (err) {
    console.error('Transfer destination error:', err?.message);
    res.set("Content-Type", "application/json");
    return res.status(500).send(JSON.stringify({ error: true, message: err?.message || "Server error" }));
  }
});

// ── LIST EMPLOYEES (reads live from Google Sheet) ─────────────────────────────
app.get('/employees', requireAdminKey, async (req, res) => {
  try {
    const employees = await getEmployeeDirectory();
    res.json({
      count: employees.length,
      source: process.env.GOOGLE_API_KEY ? 'google_sheet' : 'fallback',
      employees: employees.map(e => ({ name: e.name, aliases: e.aliases, phone: e.phone, email: e.email, conditions: e.conditions, gender: e.gender }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── EMPLOYEE LOOKUP BY NAME ───────────────────────────────────────────────────
/**
 * POST /lookup-employee
 * Called by Vapi when it needs an employee's email or phone by name.
 *
 * Request body:
 *   { "employee_name": "Bob" }
 *
 * Response:
 *   { "found": true, "name": "Bob Gutermuth", "email": "bobgutermuth@panarchy.io",
 *     "phone": "+15129255665" }
 */
app.post('/lookup-employee', requireVapiSecret, async (req, res) => {
  try {
    const { send: vapiResponse, args: leArgs } = makeResponder(req, res);
    const { employee_name } = leArgs;

    if (!employee_name) {
      return vapiResponse({ found: false, error: 'employee_name is required' });
    }

    const employees = await getEmployeeDirectory();
    const employee  = findEmployee(employees, employee_name);

    if (!employee) {
      console.warn(`Employee lookup failed: "${employee_name}"`);
      return vapiResponse({
        found: false,
        message: `I wasn't able to find ${employee_name} in the ${COMPANY_NAME} directory.`
      });
    }

    console.log(`Employee lookup: "${employee_name}" → ${employee.name}`);
    return vapiResponse({
      found:   true,
      name:    employee.name,
      email:   employee.email,
      phone:   employee.phone,
      gender:  getPronoun(employee.gender),
    });

  } catch (err) {
    console.error('Employee lookup error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── HTML ESCAPE HELPERS ──────────────────────────────────────────────────────
// Caller-supplied strings (transcript, summary, name, company, phone, reason)
// are interpolated into the consultant's email body. Without escaping, any
// caller could inject HTML (or even break the table layout with a stray "<").
// Escape on the way out to keep the template render-safe regardless of input.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same as escapeHtml, but preserves line breaks as <br> — useful for
// transcripts and summaries which span multiple sentences.
function escapeHtmlMultiline(s) {
  return escapeHtml(s).replace(/\r?\n/g, '<br>');
}

// Validate that a user-supplied URL is safe to put inside href="...".
// Rejects javascript:, data:, file:, etc. Returns '' if invalid (caller should
// then skip rendering the link).
function safeHttpUrl(s) {
  if (!s) return '';
  const str = String(s).trim();
  if (!/^https?:\/\//i.test(str)) return '';
  return escapeHtml(str);
}

// ── MICROSOFT GRAPH CONFIG ───────────────────────────────────────────────────
const GRAPH_TENANT_ID     = process.env.MS_TENANT_ID;
const GRAPH_CLIENT_ID     = process.env.MS_CLIENT_ID;
const GRAPH_CLIENT_SECRET = process.env.MS_CLIENT_SECRET;
const SENDER_EMAIL        = process.env.MS_SENDER_EMAIL || 'receptionist@panarchy.io';

// ── VAPI CONFIG ───────────────────────────────────────────────────────────────
const VAPI_PRIVATE_KEY       = process.env.VAPI_PRIVATE_KEY;
const RILEY_ASSISTANT_ID     = process.env.RILEY_ASSISTANT_ID     || '09a90334-1570-4db2-b336-31871b1eca8a';
const SCREENER_ASSISTANT_ID  = process.env.SCREENER_ASSISTANT_ID  || '499fd3ef-0f43-4b77-bec6-b24d214933a7';
const SPAM_BLOCKLIST         = (() => {
  try { return JSON.parse(process.env.SPAM_BLOCKLIST || '[]'); } catch(e) { return []; }
})();

/**
 * Get a Microsoft Graph access token using client credentials flow.
 * Token is cached for 55 minutes to avoid unnecessary requests.
 */
let graphTokenCache = null;
let graphTokenExpiry = 0;

async function getGraphToken() {
  const now = Date.now();
  if (graphTokenCache && now < graphTokenExpiry) return graphTokenCache;

  if (!GRAPH_TENANT_ID || !GRAPH_CLIENT_ID || !GRAPH_CLIENT_SECRET) {
    throw new Error('Microsoft Graph credentials not configured');
  }

  const response = await axios.post(
    `https://login.microsoftonline.com/${GRAPH_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     GRAPH_CLIENT_ID,
      client_secret: GRAPH_CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  graphTokenCache = response.data.access_token;
  graphTokenExpiry = now + (55 * 60 * 1000); // cache 55 min
  return graphTokenCache;
}

// ── SEND MESSAGE EMAIL ────────────────────────────────────────────────────────
/**
 * POST /send-message
 *
 * Called by Vapi/Riley when:
 *   (a) a caller leaves a message with the receptionist, or
 *   (b) a caller is sent to voicemail after an unanswered transfer
 *
 * Request body:
 * {
 *   "scenario":          "message" | "voicemail",
 *   "consultant_name":   "Bob Gutermuth",
 *   "consultant_email":  "bobgutermuth@panarchy.io",
 *   "caller_name":       "John Smith",
 *   "caller_company":    "Dell",
 *   "caller_phone":      "+15551234567",
 *   "call_reason":       "Following up on the Q3 strategy project",
 *   "summary":           "Full summary of what was discussed before voicemail",
 *   "transcript":        "Voicemail transcript text (if available)",
 *   "voicemail_url":     "https://... (link to recording, if available)"
 * }
 */
app.post('/send-message', requireVapiSecret, async (req, res) => {
  try {
    const { send: vapiResponse, args: smArgs } = makeResponder(req, res);

    // Diagnostic: which fields actually arrived? Helps when Vapi's envelope
    // changes shape and the args adapter below picks the wrong branch.
    // No PII logged — only field PRESENCE.
    const present = (k) => smArgs[k] !== undefined && smArgs[k] !== null && smArgs[k] !== '' ? 'yes' : 'no';
    console.log(`/send-message received: bodyKeys=[${Object.keys(req.body || {}).join(',')}] argsKeys=[${Object.keys(smArgs || {}).join(',')}] toEmail=${present('toEmail')} consultant_email=${present('consultant_email')} toName=${present('toName')} callerName=${present('callerName')}`);

    // ── ARG SHAPE ADAPTER ─────────────────────────────────────────────────
    // We accept TWO arg shapes so the Vapi-side migration from the legacy
    // `send_message_email` code-tool to this webhook can happen as a single
    // tool-type flip — Riley's prompt and the field names don't have to
    // change in lockstep with our deploy.
    //
    //   Native shape (preferred — supports voicemail scenario, branded HTML):
    //     consultant_email, consultant_name, caller_name, caller_company,
    //     caller_phone, call_reason, summary, scenario, transcript, voicemail_url
    //
    //   Legacy Vapi `send_message_email` shape:
    //     toEmail, toName, callerName, callerCompany, callerNumber,
    //     summary (=topic, becomes call_reason), urgency, details (=body)
    //
    // Discriminate by the most distinguishing field: `consultant_email` (ours)
    // vs `toEmail` (legacy). If neither is present, vapiResponse() will reject
    // below.
    const isLegacyShape = smArgs.toEmail !== undefined && smArgs.consultant_email === undefined;
    const {
      scenario,
      consultant_name,
      consultant_email,
      caller_name,
      caller_company,
      caller_phone,
      call_reason,
      summary,
      transcript,
      voicemail_url,
    } = isLegacyShape
      ? {
          // Legacy code-tool was message-only (no voicemail support)
          scenario:         'message',
          consultant_name:  smArgs.toName,
          consultant_email: smArgs.toEmail,
          caller_name:      smArgs.callerName    || 'Unknown caller',
          caller_company:   smArgs.callerCompany || 'Unknown company',
          caller_phone:     smArgs.callerNumber  || 'Not provided',
          // Vapi tool's `summary` was the short topic (subject line); `details`
          // was the longer narrative. Map them onto our two fields.
          call_reason:      smArgs.summary       || smArgs.urgency || 'Not specified',
          summary:          smArgs.details       || '',
          transcript:       '',
          voicemail_url:    '',
        }
      : {
          scenario:         smArgs.scenario        || 'message',
          consultant_name:  smArgs.consultant_name,
          consultant_email: smArgs.consultant_email,
          caller_name:      smArgs.caller_name     || 'Unknown caller',
          caller_company:   smArgs.caller_company  || 'Unknown company',
          caller_phone:     smArgs.caller_phone    || 'Not provided',
          call_reason:      smArgs.call_reason     || 'Not specified',
          summary:          smArgs.summary         || '',
          transcript:       smArgs.transcript      || '',
          voicemail_url:    smArgs.voicemail_url   || '',
        };

    if (!consultant_email) {
      return vapiResponse({ success: false, error: 'consultant_email (or toEmail) is required' });
    }

    const isVoicemail = scenario === 'voicemail';
    const timestamp   = new Date().toLocaleString('en-US', {
      timeZone:     'America/Chicago',
      dateStyle:    'full',
      timeStyle:    'short',
    });

    // ── ESCAPE EVERY USER-CONTROLLED VALUE BEFORE TEMPLATE INTERPOLATION ───
    // Subject is sent as a JSON field to Graph (plain-text), so it doesn't need
    // HTML escaping. Everything that lands inside the htmlBody string DOES.
    const safe = {
      consultantFirst: escapeHtml((consultant_name || 'there').split(' ')[0]),
      callerName:      escapeHtml(caller_name),
      callerCompany:   escapeHtml(caller_company),
      callerPhone:     escapeHtml(caller_phone),
      callReason:      escapeHtml(call_reason),
      summary:         escapeHtmlMultiline(summary),
      transcript:      escapeHtmlMultiline(transcript),
      voicemailUrl:    safeHttpUrl(voicemail_url), // '' if not http(s)
    };

    // ── EMAIL SUBJECT ──────────────────────────────────────────────────────
    const subject = isVoicemail
      ? `📞 Voicemail from ${caller_name} — ${caller_company}`
      : `📋 Message from ${caller_name} — ${caller_company}`;

    // ── EMAIL BODY (HTML) ──────────────────────────────────────────────────
    const voicemailSection = isVoicemail ? `
      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#060908;text-transform:uppercase;letter-spacing:0.05em;">
            Voicemail Transcript
          </p>
          <div style="background:#f5f5f5;border-left:4px solid ${BRAND_ACCENT};padding:16px;border-radius:4px;font-size:14px;color:#333;line-height:1.6;">
            ${safe.transcript || 'Transcript not available.'}
          </div>
        </td>
      </tr>
      ${safe.voicemailUrl ? `
      <tr>
        <td style="padding:16px 32px 0;">
          <a href="${safe.voicemailUrl}"
             style="display:inline-block;background:${BRAND_PRIMARY};color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:4px;font-size:14px;font-weight:600;">
            ▶ Listen to Voicemail
          </a>
        </td>
      </tr>` : ''}` : '';

    const summarySection = safe.summary ? `
      <tr>
        <td style="padding:24px 32px 0;">
          <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#060908;text-transform:uppercase;letter-spacing:0.05em;">
            Call Summary
          </p>
          <div style="background:#f5f5f5;border-left:4px solid ${BRAND_PRIMARY};padding:16px;border-radius:4px;font-size:14px;color:#333;line-height:1.6;">
            ${safe.summary}
          </div>
        </td>
      </tr>` : '';

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- HEADER -->
        <tr>
          <td style="background:${BRAND_PRIMARY};padding:24px 32px;">
            <img src="${SELF_BASE_URL}/logo"
                 alt="${COMPANY_NAME}" height="48" style="display:block;margin-bottom:4px;" />
            <p style="margin:4px 0 0;font-size:13px;color:#888;letter-spacing:0.02em;">
              ${isVoicemail ? 'VOICEMAIL NOTIFICATION' : 'MESSAGE NOTIFICATION'}
            </p>
          </td>
        </tr>

        <!-- ACCENT BAR -->
        <tr><td style="background:${BRAND_ACCENT};height:4px;"></td></tr>

        <!-- GREETING -->
        <tr>
          <td style="padding:28px 32px 0;">
            <p style="margin:0;font-size:16px;color:#333;">
              Hi ${safe.consultantFirst},
            </p>
            <p style="margin:8px 0 0;font-size:15px;color:#555;line-height:1.5;">
              ${isVoicemail
                ? `A caller was transferred to you but you were unavailable. They left a voicemail.`
                : `A caller left a message for you with the ${COMPANY_NAME} receptionist.`}
            </p>
          </td>
        </tr>

        <!-- CALLER DETAILS -->
        <tr>
          <td style="padding:24px 32px 0;">
            <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#060908;text-transform:uppercase;letter-spacing:0.05em;">
              Caller Details
            </p>
            <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;">
              <tr style="background:#fafafa;">
                <td style="padding:10px 16px;font-size:13px;color:#888;width:140px;">Name</td>
                <td style="padding:10px 16px;font-size:14px;color:#060908;font-weight:500;">${safe.callerName}</td>
              </tr>
              <tr style="border-top:1px solid #e8e8e8;">
                <td style="padding:10px 16px;font-size:13px;color:#888;">Company</td>
                <td style="padding:10px 16px;font-size:14px;color:#060908;font-weight:500;">${safe.callerCompany}</td>
              </tr>
              <tr style="background:#fafafa;border-top:1px solid #e8e8e8;">
                <td style="padding:10px 16px;font-size:13px;color:#888;">Phone</td>
                <td style="padding:10px 16px;font-size:14px;color:#060908;font-weight:500;">${safe.callerPhone}</td>
              </tr>
              <tr style="border-top:1px solid #e8e8e8;">
                <td style="padding:10px 16px;font-size:13px;color:#888;">Reason</td>
                <td style="padding:10px 16px;font-size:14px;color:#060908;font-weight:500;">${safe.callReason}</td>
              </tr>
              <tr style="background:#fafafa;border-top:1px solid #e8e8e8;">
                <td style="padding:10px 16px;font-size:13px;color:#888;">Received</td>
                <td style="padding:10px 16px;font-size:14px;color:#060908;">${timestamp} CT</td>
              </tr>
            </table>
          </td>
        </tr>

        ${summarySection}
        ${voicemailSection}

        <!-- FOOTER -->
        <tr>
          <td style="padding:32px;border-top:1px solid #e8e8e8;margin-top:24px;">
            <p style="margin:0;font-size:12px;color:#aaa;line-height:1.5;">
              This message was taken by the ${COMPANY_NAME} AI Receptionist.<br>
              Sent from <a href="mailto:${SENDER_EMAIL}" style="color:${BRAND_ACCENT};">${SENDER_EMAIL}</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    // ── SEND VIA MICROSOFT GRAPH ───────────────────────────────────────────
    const token = await getGraphToken();

    await axios.post(
      `https://graph.microsoft.com/v1.0/users/${SENDER_EMAIL}/sendMail`,
      {
        message: {
          subject,
          body: { contentType: 'HTML', content: htmlBody },
          toRecipients: [
            { emailAddress: { address: consultant_email } }
          ],
          ccRecipients: [
            { emailAddress: { address: SENDER_EMAIL } }
          ],
        },
        saveToSentItems: true,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`Email sent to ${consultant_email} — scenario: ${scenario}, caller: ${caller_name} (arg shape: ${isLegacyShape ? 'legacy/Vapi' : 'native'})`);
    return vapiResponse({
      success: true,
      message:  `Message emailed to ${consultant_name} at ${consultant_email}`,
      // Legacy-compat fields so prompts that read these from the old code-tool still work:
      toEmail:  consultant_email,
      fromUser: SENDER_EMAIL,
      subject,
    });

  } catch (err) {
    console.error('Send message error:', err.response?.data || err.message);
    return res.status(500).json({
      results: [{ toolCallId: 'unknown', result: { success: false, error: err.response?.data?.error?.message || err.message } }]
    });
  }
});

// ── IN-MEMORY SESSION STORE ──────────────────────────────────────────────────
// Stores inbound call sessions and delay flags.
// At Panarchy's call volume this is perfectly sufficient.
// Upgrade to Upstash Redis if you ever run multiple Railway instances.
const sessionStore = new Map();

function storeSession(key, value, ttlMs) {
  sessionStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function getSession(key) {
  const entry = sessionStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { sessionStore.delete(key); return null; }
  return entry.value;
}

// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStore.entries()) {
    if (now > entry.expiresAt) sessionStore.delete(key);
  }
}, 5 * 60 * 1000);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── VAPI API HELPERS ──────────────────────────────────────────────────────────
async function getVapiCall(callId) {
  const r = await axios.get(
    `https://api.vapi.ai/call/${callId}`,
    { headers: { Authorization: `Bearer ${VAPI_PRIVATE_KEY}` } }
  );
  return r.data;
}

async function postToControlUrl(controlUrl, payload) {
  return axios.post(controlUrl, payload, {
    headers: {
      Authorization: `Bearer ${VAPI_PRIVATE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
}

// ── VAPI WEBHOOK ─────────────────────────────────────────────────────────────
/**
 * POST /vapi-webhook
 *
 * Central Vapi webhook handler. Handles:
 *   - assistant-request: spam check + ring delay + route to Riley
 *   - end-of-call-report: log call summary
 *   - status-update: log status changes
 *   - screening-complete: handle employee accept/reject
 */
app.post('/vapi-webhook', requireVapiSecret, async (req, res) => {
  try {
    const message = req.body?.message || req.body;
    const type    = message?.type;

    console.log(`Vapi webhook: ${type}`);

    // ── ASSISTANT REQUEST ───────────────────────────────────────────────────
    if (type === 'assistant-request') {
      const callerNumber = message?.call?.customer?.number || 'unknown';
      const callId       = message?.call?.id || '';

      console.log(`Inbound call from ${callerNumber} (call: ${callId})`);

      // Check spam blocklist
      if (SPAM_BLOCKLIST.includes(callerNumber)) {
        console.log(`Blocked spam caller: ${callerNumber}`);
        return res.json({
          error: 'We are unable to accept your call at this time. Goodbye.'
        });
      }

      // Store inbound session for warm transfer bridging (TTL 10 min)
      if (callId) {
        storeSession(`inbound:${callerNumber}`, { callId, createdAt: Date.now() }, 10 * 60 * 1000);
        storeSession(`callId:${callId}`, { callerNumber, createdAt: Date.now() }, 10 * 60 * 1000);
      }

      // Ring delay — 2–3 rings (~5.5s) so caller hears natural PSTN ringing
      // Only delays once per call to handle Vapi retries gracefully
      const alreadyDelayed = getSession(`delay:${callId}`);
      if (!alreadyDelayed && callId) {
        storeSession(`delay:${callId}`, true, 2 * 60 * 1000); // TTL 2 min
        console.log(`Ring delay: waiting 5.5s for call ${callId}`);
        await sleep(5500);
      }

      return res.json({ assistantId: RILEY_ASSISTANT_ID });
    }

    // ── END OF CALL REPORT ──────────────────────────────────────────────────
    if (type === 'end-of-call-report') {
      const call        = message?.call || {};
      const callId      = call?.id || 'unknown';
      const endedReason = message?.endedReason || 'unknown';
      const summary     = message?.summary || '';
      const durationMs  = call?.endedAt && call?.startedAt
        ? new Date(call.endedAt) - new Date(call.startedAt) : 0;

      console.log(`Call ended: ${callId} | reason: ${endedReason} | duration: ${Math.round(durationMs/1000)}s`);
      if (summary) console.log(`Call summary: ${summary}`);

      // ── SCREENER CALL ENDED — extract decision and bridge inbound call ────
      if (SCREENER_ASSISTANT_ID && call?.assistantId === SCREENER_ASSISTANT_ID) {
        console.log(`Screener call ended: ${callId}`);

        // Extract callerNumber from screener call variableValues (passed in by Riley)
        const callerNumber = call?.assistantOverrides?.variableValues?.callerNumber
          || getSession(`screener:${callId}`);

        if (!callerNumber) {
          console.warn('Screener ended but no callerNumber found — cannot bridge');
          return res.json({ received: true });
        }

        // Find inbound call session
        const inboundSession = getSession(`inbound:${callerNumber}`);
        if (!inboundSession?.callId) {
          console.warn(`No inbound session found for caller ${callerNumber}`);
          return res.json({ received: true });
        }
        const inboundCallId = inboundSession.callId;

        // Extract ACCEPT or REJECT from screener transcript
        // Last assistant message should be exactly "ACCEPT" or "REJECT"
        const messages = message?.artifact?.messages || [];
        let decision = 'REJECT'; // default to reject for safety
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          const text = (m?.message || m?.content || '').toUpperCase().trim();
          if (text === 'ACCEPT' || text === 'REJECT') {
            decision = text;
            break;
          }
          // Also check for partial matches
          if (text.includes('ACCEPT')) { decision = 'ACCEPT'; break; }
          if (text.includes('REJECT')) { decision = 'REJECT'; break; }
        }

        console.log(`Screener decision: ${decision} for inbound call ${inboundCallId}`);

        if (!VAPI_PRIVATE_KEY) {
          console.warn('VAPI_PRIVATE_KEY not set — cannot control inbound call');
          return res.json({ received: true });
        }

        try {
          // Fetch inbound call to get controlUrl
          const inboundCall = await getVapiCall(inboundCallId);
          const controlUrl  = inboundCall?.monitor?.controlUrl;

          if (!controlUrl) {
            console.warn(`No controlUrl found for inbound call ${inboundCallId}`);
            return res.json({ received: true });
          }

          if (decision === 'ACCEPT') {
            // Get employee phone from screener variableValues
            const employeePhone = call?.assistantOverrides?.variableValues?.employeePhone;
            if (employeePhone) {
              // Transfer the inbound call to the employee
              await postToControlUrl(controlUrl, {
                type: 'transfer',
                destination: { type: 'number', number: employeePhone }
              });
              console.log(`Transferred inbound call ${inboundCallId} to ${employeePhone}`);
            } else {
              // No phone — just say connecting
              await postToControlUrl(controlUrl, {
                type: 'say',
                say: 'Connecting you now. One moment please.'
              });
            }
          } else {
            // REJECT — return to Riley to take message
            await postToControlUrl(controlUrl, {
              type: 'say',
              say: "I'm sorry, they're not available right now. Let me take a message for you."
            });
          }
        } catch (e) {
          console.error(`Failed to control inbound call: ${e.message}`);
        }

        return res.json({ received: true, decision });
      }

      return res.json({ received: true });
    }

    // ── STATUS UPDATE ───────────────────────────────────────────────────────
    if (type === 'status-update') {
      const status = message?.status;
      const callId = message?.call?.id || 'unknown';
      console.log(`Call ${callId} status: ${status}`);
      return res.json({ received: true });
    }

    // ── SCREENING COMPLETE (manual callback fallback) ───────────────────────
    if (type === 'screening-complete' || req.body?.originalCallId) {
      const { originalCallId, employeePhone, decision } = req.body;

      console.log(`Manual screening complete: call ${originalCallId} | decision: ${decision}`);

      if (!originalCallId || !VAPI_PRIVATE_KEY) {
        return res.json({ received: true, warning: 'Missing originalCallId or VAPI_PRIVATE_KEY' });
      }

      try {
        const inboundCall = await getVapiCall(originalCallId);
        const controlUrl  = inboundCall?.monitor?.controlUrl;

        if (!controlUrl) {
          return res.json({ received: true, warning: 'No controlUrl on inbound call' });
        }

        if (decision === 'accept' && employeePhone) {
          await postToControlUrl(controlUrl, {
            type: 'transfer',
            destination: { type: 'number', number: employeePhone }
          });
        } else {
          await postToControlUrl(controlUrl, {
            type: 'say',
            say: "I'm sorry, they're not available right now. Let me take a message for you."
          });
        }
      } catch(e) {
        console.error('Screening complete error:', e.message);
      }

      return res.json({ received: true, decision });
    }

    // ── DEFAULT ─────────────────────────────────────────────────────────────
    return res.json({ received: true, type });

  } catch (err) {
    console.error('Vapi webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── STATIC LOGO ──────────────────────────────────────────────────────────────
app.get('/logo', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo.png'));
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'panarchy-receptionist-lookup' }));

// ── LEGAL (privacy + terms) ──────────────────────────────────────────────────
// Public HTML pages served from this server so we have stable URLs to give
// Twilio's A2P 10DLC reviewer (TCR). Edit content in legal.js.
try {
  require('./legal').mountRoutes(app);
  console.log('Legal routes mounted: /privacy, /terms');
} catch (err) {
  console.warn('Legal routes not mounted:', err.message);
}

// ── SMS RECEPTIONIST (Twilio + Claude) ───────────────────────────────────────
// Mounted last so its /sms-webhook + /sms-debug routes coexist with everything
// above. See sms-receptionist.js for the full architecture.
try {
  require('./sms-receptionist').mountRoutes(app);
  console.log('SMS receptionist routes mounted: /sms-webhook, /sms-debug');
} catch (err) {
  console.warn('SMS receptionist not mounted:', err.message);
}

// ════════════════════════════════════════════════════════════════════════════════
// WARM TRANSFER FOR BLAND
// ════════════════════════════════════════════════════════════════════════════════
// Bland Starter tier doesn't have native warm transfer, so we roll our own.
//
// Architecture (full doc in PLAN.md):
//   1. Bland's Michael calls `screen_and_transfer` tool (POST /screen-and-transfer)
//      with caller info + consultant phone + summary
//   2. We initiate an outbound Twilio call to the consultant playing
//      "<caller> from <co> is calling about <summary>. Press 1 to accept, 2 to decline."
//   3. Tool BLOCKS waiting (~50s max — Bland's tool timeout) for the consultant's DTMF
//   4a. On 1 (accept): screener's TwiML transitions to <Dial><Conference name=X/>
//       so consultant joins conf X. Tool returns {status:"accepted"}.
//       Bland's prompt then triggers static transfer (transfer_phone_number);
//       caller dials our /twiml/conference-join, which reads From: header,
//       finds the matching conference name, joins them. Bridge complete.
//   4b. On 2 / no-input / no-answer: tool returns {status:"rejected"}. Bland's
//       Michael falls back to message-taking (send_message_email).
//
// State: in-memory sessionStore (caller_phone → {conferenceName, status}).
// 5-min TTL. Not durable across restarts but fine at Panarchy's volume.
//
// Defensive design:
// - /twiml/conference-join falls back to MOST RECENT mapping if From: lookup
//   fails (covers cases where Bland's transfer doesn't preserve caller phone)
// - All endpoints log extensively so we can debug live transfers in production
// - Outbound screener call has 20s ring timeout + Twilio status callback
//   that frees the polling map even if everything else fails

// Twilio auth supports two patterns:
//   (a) Classic: TWILIO_ACCOUNT_SID (AC...) + TWILIO_AUTH_TOKEN — auth uses AC:token
//   (b) API Key: TWILIO_ACCOUNT_SID (AC...) + TWILIO_API_KEY_SID (SK...) + TWILIO_API_KEY_SECRET
//       — auth uses SK:secret, but the URL path STILL needs the AC SID.
// Background (inherited from dialog-receptionist): the Dialog Railway had
// TWILIO_ACCOUNT_SID accidentally set to an SK (API Key SID). The runtime
// detection below reads whichever vars are set, so the operator only needs to
// add TWILIO_AC_SID (an AC...) to Railway alongside the existing var.
// (Dialog's actual AC value is omitted here — set it via env, not in code.)
const _rawAcctSid = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_ACCOUNT_SID =
  process.env.TWILIO_AC_SID                                              // explicit override
  || (_rawAcctSid.startsWith('AC') ? _rawAcctSid : '')                   // existing var if it's actually AC
  || '';
const _existingIsApiKey = _rawAcctSid.startsWith('SK');
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID || (_existingIsApiKey ? _rawAcctSid : '');
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET || (_existingIsApiKey ? process.env.TWILIO_AUTH_TOKEN : '');
const TWILIO_AUTH_TOKEN = (!_existingIsApiKey ? process.env.TWILIO_AUTH_TOKEN : '') || '';
const TWILIO_OUTBOUND_FROM = process.env.TWILIO_OUTBOUND_FROM_NUMBER || process.env.TWILIO_NUMBER;
const SELF_BASE_URL = process.env.SELF_BASE_URL || 'https://panarchy-receptionist-webhook-production.up.railway.app';

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

// Initiate an outbound Twilio call. Returns { sid, status, ... }.
// URL path uses the Account SID (AC...). Auth uses either API Key (SK...) +
// secret, OR the Account SID + Auth Token, whichever is configured.
async function makeOutboundTwilioCall({ to, from, twimlUrl, statusCallbackUrl }) {
  if (!TWILIO_ACCOUNT_SID) {
    throw new Error('No Twilio Account SID (AC...) configured. Set TWILIO_AC_SID in Railway.');
  }
  if (!from) {
    throw new Error('TWILIO_OUTBOUND_FROM_NUMBER (or TWILIO_NUMBER) not set');
  }
  const authUser = TWILIO_API_KEY_SID || TWILIO_ACCOUNT_SID;
  const authPass = TWILIO_API_KEY_SECRET || TWILIO_AUTH_TOKEN;
  if (!authPass) {
    throw new Error('No Twilio auth credential. Set TWILIO_API_KEY_SECRET (with API Key) or TWILIO_AUTH_TOKEN (classic).');
  }
  const params = new URLSearchParams({
    To: to,
    From: from,
    Url: twimlUrl,
    Method: 'POST',
    Timeout: '20', // ring 20s before no-answer
    StatusCallback: statusCallbackUrl,
    StatusCallbackMethod: 'POST',
    StatusCallbackEvent: 'completed',
  });
  const auth = Buffer.from(`${authUser}:${authPass}`).toString('base64');
  const r = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`,
    params.toString(),
    { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } },
  );
  return r.data;
}

// Track the most recent screener mapping globally so /twiml/conference-join can
// fall back to it if From-header lookup fails. Updated on every screener launch.
let mostRecentScreener = null;

// ─────────────────────────────────────────────────────────────────────────────
// POST /screen-and-transfer
// Called by Bland's `screen_and_transfer` tool. Blocks waiting for the
// consultant's DTMF response on the screener call (up to ~50 seconds).
// ─────────────────────────────────────────────────────────────────────────────
app.post('/screen-and-transfer', requireVapiSecret, async (req, res) => {
  const { send: bResp, args } = makeResponder(req, res);
  const {
    consultant_name, consultant_phone, consultant_email,
    caller_name, caller_company, caller_phone,
    summary,
  } = args;

  console.log(`[SCREEN] called: caller=${caller_name}@${caller_company} (${caller_phone}) → consultant=${consultant_name} (${consultant_phone}) summary="${summary}"`);

  if (!consultant_phone || !caller_phone) {
    return bResp({ status: 'error', message: 'consultant_phone and caller_phone are required' });
  }

  const callerPhoneNorm = normalizePhone(caller_phone);
  const consultantPhoneNorm = normalizePhone(consultant_phone);
  const conferenceName = `panarchy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Seed the screener state. Status starts pending; screener-action mutates it.
  const screenerKey = `screener:${callerPhoneNorm}`;
  storeSession(screenerKey, {
    status: 'pending',
    conferenceName,
    callerPhone: callerPhoneNorm,
    callerName: caller_name,
    callerCompany: caller_company,
    consultantPhone: consultantPhoneNorm,
    consultantName: consultant_name,
    consultantEmail: consultant_email,
    summary,
    createdAt: Date.now(),
  }, 5 * 60 * 1000);
  mostRecentScreener = screenerKey;

  // TwiML the consultant call hits when they answer
  const screenerTwimlUrl = `${SELF_BASE_URL}/twiml/screener?key=${encodeURIComponent(screenerKey)}`;
  const statusCallbackUrl = `${SELF_BASE_URL}/twiml/screener-status?key=${encodeURIComponent(screenerKey)}`;

  let callSid;
  try {
    const callResponse = await makeOutboundTwilioCall({
      to: consultantPhoneNorm,
      from: TWILIO_OUTBOUND_FROM,
      twimlUrl: screenerTwimlUrl,
      statusCallbackUrl,
    });
    callSid = callResponse.sid;
    console.log(`[SCREEN] outbound call to ${consultantPhoneNorm} sid=${callSid}`);
  } catch (e) {
    console.error('[SCREEN] outbound call failed:', e.response?.data || e.message);
    return bResp({ status: 'error', message: 'failed to reach consultant' });
  }

  // Poll for the screener result (consultant DTMF or call-ended status)
  // Bland tool timeout is 60s; we cap at 50s so we return cleanly before they
  // time out their side. Poll every 500ms.
  const POLL_MS = 500, MAX_WAIT_MS = 50000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const state = getSession(screenerKey);
    if (state && state.status !== 'pending') {
      console.log(`[SCREEN] resolved key=${screenerKey} status=${state.status} (${Date.now() - start}ms)`);
      return bResp({
        status: state.status, // 'accepted' | 'rejected' | 'no_answer' | 'voicemail'
        consultant_name,
        message: state.status === 'accepted'
          ? 'Consultant accepted; trigger static transfer now.'
          : 'Consultant unavailable; fall back to message-taking.',
      });
    }
    await sleep(POLL_MS);
  }
  // Timed out — assume no-answer
  console.warn(`[SCREEN] timed out waiting for screener key=${screenerKey}`);
  return bResp({ status: 'timeout', message: 'No response from consultant; fall back to message-taking.' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /twiml/screener
// TwiML returned to Twilio when the consultant answers. Says the summary,
// then Gathers a single DTMF (1=accept, 2=decline).
// Twilio sends Gather result to /twiml/screener-action.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/twiml/screener', (req, res) => {
  const screenerKey = req.query.key;
  const state = screenerKey ? getSession(screenerKey) : null;
  if (!state) {
    console.warn(`[SCREEN/twiml] no state for key=${screenerKey}`);
    res.set('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna">This call cannot be completed. Goodbye.</Say><Hangup/></Response>`);
  }

  const summarySafe = escapeXml(state.summary);
  const callerSafe = escapeXml(state.callerName || 'a caller');
  const companySafe = state.callerCompany && state.callerCompany.toLowerCase() !== 'unknown'
    ? ` from ${escapeXml(state.callerCompany)}` : '';

  const actionUrl = `${SELF_BASE_URL}/twiml/screener-action?key=${encodeURIComponent(screenerKey)}`;

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">Hello, this is ${COMPANY_NAME}'s receptionist. ${callerSafe}${companySafe} is on the line and would like to speak with you about ${summarySafe}.</Say>
  <Gather numDigits="1" timeout="15" action="${actionUrl}" method="POST">
    <Say voice="Polly.Joanna">Press 1 to take the call. Press 2 to send the caller to voicemail.</Say>
  </Gather>
  <Say voice="Polly.Joanna">No response received. Sending the caller to voicemail. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /twiml/screener-action
// Twilio Gather posts here with the DTMF digit. If 1, return TwiML that joins
// consultant to the conference (so they're waiting when caller arrives). If
// 2/anything-else, return TwiML to hang up.
// Either way, mutate the screener state so the polling /screen-and-transfer
// returns to Bland.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/twiml/screener-action', (req, res) => {
  const screenerKey = req.query.key;
  const digits = req.body?.Digits;
  console.log(`[SCREEN/action] key=${screenerKey} digits="${digits}"`);

  const state = screenerKey ? getSession(screenerKey) : null;
  if (!state) {
    console.warn(`[SCREEN/action] no state for key=${screenerKey}`);
    res.set('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna">Session expired. Goodbye.</Say><Hangup/></Response>`);
  }

  res.set('Content-Type', 'text/xml');
  if (digits === '1') {
    // Accept: update state and join consultant to the conference
    state.status = 'accepted';
    storeSession(screenerKey, state, 5 * 60 * 1000);
    console.log(`[SCREEN/action] ACCEPTED — joining consultant to ${state.conferenceName}`);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Connecting you now.</Say>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="false" waitUrl="">${escapeXml(state.conferenceName)}</Conference>
  </Dial>
</Response>`);
  } else {
    // Reject (2 or anything else)
    state.status = 'rejected';
    storeSession(screenerKey, state, 5 * 60 * 1000);
    console.log(`[SCREEN/action] REJECTED (digit=${digits})`);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sending the caller to voicemail. Goodbye.</Say>
  <Hangup/>
</Response>`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /twiml/screener-status
// Twilio status callback — fires when the screener call ends. If the call
// completed without DTMF (consultant never picked up, or hung up before
// pressing), mark the state as no_answer so the polling endpoint returns
// quickly instead of waiting the full 50s.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/twiml/screener-status', (req, res) => {
  const screenerKey = req.query.key;
  const callStatus = req.body?.CallStatus;
  console.log(`[SCREEN/status] key=${screenerKey} status=${callStatus}`);
  const state = screenerKey ? getSession(screenerKey) : null;
  if (state && state.status === 'pending' && (callStatus === 'completed' || callStatus === 'no-answer' || callStatus === 'busy' || callStatus === 'failed' || callStatus === 'canceled')) {
    state.status = callStatus === 'no-answer' ? 'no_answer' : 'rejected';
    storeSession(screenerKey, state, 5 * 60 * 1000);
    console.log(`[SCREEN/status] resolved key=${screenerKey} → ${state.status}`);
  }
  res.status(200).send('OK');
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /twiml/conference-join
// Voice URL of the dedicated Twilio "conference-join" number. Set as
// transfer_phone_number on Bland's PRODUCTION_NUMBER inbound config. When Bland
// transfers the caller, Twilio dials this number; we look up the caller's
// conference name (by From: phone) and Dial them in.
// Defensive fallback: if From: doesn't match any mapping (e.g. Bland transfer
// doesn't preserve caller phone), use the most recent screener (works at low
// concurrency, which Panarchy has).
// ─────────────────────────────────────────────────────────────────────────────
app.post('/twiml/conference-join', (req, res) => {
  const fromHeader = req.body?.From || '';
  const fromNorm = normalizePhone(fromHeader);
  console.log(`[CONFJOIN] caller arrived From="${fromHeader}" (normalized=${fromNorm})`);

  let state = getSession(`screener:${fromNorm}`);
  let usedFallback = false;
  if (!state) {
    // Defensive fallback — most recent screener (works only at low concurrency)
    if (mostRecentScreener) {
      state = getSession(mostRecentScreener);
      usedFallback = true;
      console.warn(`[CONFJOIN] From="${fromHeader}" had no mapping; falling back to most recent: ${mostRecentScreener}`);
    }
  }

  res.set('Content-Type', 'text/xml');
  if (!state || state.status !== 'accepted') {
    console.warn(`[CONFJOIN] no usable state (state=${state?.status || 'null'}); hanging up`);
    return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna">We were unable to complete the transfer. Please call back. Goodbye.</Say><Hangup/></Response>`);
  }

  console.log(`[CONFJOIN] joining caller to ${state.conferenceName} (fallback=${usedFallback})`);
  return res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${escapeXml(state.conferenceName)}</Conference>
  </Dial>
</Response>`);
});

// ════════════════════════════════════════════════════════════════════════════════
// DAILY SUMMARY REPORT
// ════════════════════════════════════════════════════════════════════════════════
// At 8pm Central each day, query Bland for the day's inbound calls, classify
// each as "message taken" / "difficulty" / "other", and email a branded summary
// to SUMMARY_RECIPIENT (defaults to bobgutermuth@panarchy.io).
//
// Also exposes POST /daily-summary (admin-auth) for manual triggering / testing
// without waiting for 8pm.

const BLAND_API_KEY = process.env.BLAND_API_KEY;
const SUMMARY_RECIPIENT = process.env.DAILY_SUMMARY_EMAIL || 'bobgutermuth@panarchy.io';
const SUMMARY_TIMEZONE  = process.env.DAILY_SUMMARY_TZ    || 'America/Chicago';
const PRODUCTION_NUMBER = process.env.PRODUCTION_NUMBER || '+12513335665';

/**
 * Fetch Bland's recent inbound calls. Bland's list endpoint returns most-recent
 * first; we walk pages until we've covered the requested date window.
 */
async function fetchBlandInboundCalls({ since, until }) {
  if (!BLAND_API_KEY) throw new Error('BLAND_API_KEY not set');
  const calls = [];
  let page = 0;
  const PAGE_SIZE = 50;
  // Walk up to 5 pages (250 calls) — far more than Panarchy's daily volume
  while (page < 5) {
    const r = await axios.get('https://api.bland.ai/v1/calls', {
      params: { inbound: 'true', limit: PAGE_SIZE, page },
      headers: { authorization: BLAND_API_KEY },
    });
    const batch = r.data?.calls || [];
    if (batch.length === 0) break;
    let allBeforeWindow = true;
    for (const c of batch) {
      const t = new Date(c.created_at);
      if (until && t > until) continue;            // future of window — skip
      if (since && t < since) continue;             // older than window — skip but flag
      if (t >= (since || new Date(0))) allBeforeWindow = false;
      calls.push(c);
    }
    // If oldest call in this page is already older than `since`, we're done.
    const oldestInBatch = new Date(batch[batch.length - 1].created_at);
    if (since && oldestInBatch < since) break;
    page++;
  }
  return calls;
}

/**
 * Fetch the full detail (transcript, summary) for one call.
 */
async function fetchBlandCallDetail(callId) {
  if (!BLAND_API_KEY) throw new Error('BLAND_API_KEY not set');
  const r = await axios.get(`https://api.bland.ai/v1/calls/${callId}`, {
    headers: { authorization: BLAND_API_KEY },
  });
  return r.data;
}

/**
 * Heuristic classification of a call:
 *   - 'message'    — caller successfully left a message (send_message webhook fired,
 *                    summary references a consultant name + topic)
 *   - 'difficulty' — caller or receptionist had trouble (short call, no summary,
 *                    repeated silence prompts, error messages, etc.)
 *   - 'other'      — completed but couldn't determine (e.g., system-down message,
 *                    test calls with no clear outcome)
 *
 * Also returns an array of `reasons` describing why it was flagged.
 */
function classifyCall(detail) {
  const reasons = [];
  const transcript = (detail.concatenated_transcript || '').toLowerCase();
  const summary    = detail.summary || '';
  const lengthMin  = parseFloat(detail.call_length || 0);
  const err        = detail.error_message;
  const pathwayLogs = detail.pathway_logs || [];

  // ── Difficulty signals ──
  if (err) reasons.push(`API error: ${err}`);
  if (lengthMin < 0.5 && detail.completed) reasons.push(`Very short call (${lengthMin.toFixed(2)}min) — likely caller hung up early`);
  if (transcript.includes('[extended silence')) {
    const silenceCount = (transcript.match(/\[extended silence/g) || []).length;
    if (silenceCount >= 2) reasons.push(`${silenceCount} extended silences in conversation`);
  }
  if (transcript.includes('are you still there') || transcript.includes('still there?')) {
    reasons.push('Receptionist had to prompt for caller presence');
  }
  if (transcript.includes('i didn\'t catch') || transcript.includes("didn't catch that") || transcript.includes('could you repeat') || transcript.includes('come again')) {
    reasons.push('Receptionist or caller asked for repetition');
  }
  // Look for webhook failures in pathway logs
  for (const log of pathwayLogs) {
    const pinfo = log.pathway_info || '';
    if (typeof pinfo === 'string' && pinfo.includes('Webhook Response Status') && !pinfo.includes('200 OK')) {
      reasons.push('A webhook call failed during the conversation');
      break;
    }
  }
  // System-down auto-message (1-min cap calls with no human interaction)
  if (lengthMin < 1.2 && transcript.includes('system is currently down')) {
    return { kind: 'other', reasons: ['Hit the system-down auto-message (likely from a fallback period)'], summary };
  }

  // ── Was a message successfully taken? ──
  const messageSent = pathwayLogs.some(log => {
    const p = log.pathway_info || '';
    return typeof p === 'string' && p.includes('/send-message') && p.includes('200 OK');
  }) || transcript.includes('sending your message now') || /sent.*message/.test(summary.toLowerCase());

  if (reasons.length > 0) return { kind: 'difficulty', reasons, summary, messageStillSent: messageSent };
  if (messageSent) return { kind: 'message', reasons: [], summary };
  return { kind: 'other', reasons: ['No clear outcome detected'], summary };
}

function fmtTime(iso, tz) {
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  } catch { return iso; }
}
function fmtDate(d, tz) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz });
}

function composeDailySummaryHTML({ dateLabel, messages, difficulties, other, total }) {
  const row = (cells, bg = '#fafafa') =>
    `<tr style="background:${bg}">${cells.map(c => `<td style="padding:10px 16px;font-size:13px;color:#060908;vertical-align:top;">${c}</td>`).join('')}</tr>`;

  // Format "Caller, Company" — fall back to just name if no company captured;
  // if neither, show "Unknown".
  const formatCaller = (name, company) => {
    const n = (name && name !== 'Unknown') ? name : '';
    const c = (company && company !== 'Unknown') ? company : '';
    if (n && c) return `${escapeHtml(n)}, ${escapeHtml(c)}`;
    if (n) return escapeHtml(n);
    if (c) return escapeHtml(c);
    return 'Unknown';
  };

  const messageRows = messages.length
    ? messages.map((m, i) => row([
        fmtTime(m.created_at, SUMMARY_TIMEZONE),
        formatCaller(m.caller, m.callerCompany),
        escapeHtml(m.consultant || 'Unknown'),
        escapeHtml(m.summary || '(no summary)'),
      ], i % 2 ? '#ffffff' : '#fafafa')).join('')
    : `<tr><td colspan="4" style="padding:16px;text-align:center;color:#888;font-style:italic;">No messages received today.</td></tr>`;

  const difficultyRows = difficulties.length
    ? difficulties.map((d, i) => row([
        fmtTime(d.created_at, SUMMARY_TIMEZONE),
        // For difficulties, show name+company if extracted, else fall back to phone
        (d.caller && d.caller !== d.callerNumber)
          ? formatCaller(d.caller, d.callerCompany) + `<br><span style="color:#888;font-size:12px;">${escapeHtml(d.callerNumber || '')}</span>`
          : escapeHtml(d.callerNumber || 'Unknown'),
        `<ul style="margin:0;padding-left:18px;">${d.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` +
          (d.summary ? `<p style="margin:6px 0 0;color:#666;font-size:12px;font-style:italic;">${escapeHtml(d.summary)}</p>` : ''),
        d.messageStillSent ? '<span style="color:#0a7;font-weight:600;">Message captured anyway</span>' : '<span style="color:#c33;font-weight:600;">No message taken</span>',
      ], i % 2 ? '#fff5f5' : '#fff8f8')).join('')
    : `<tr><td colspan="4" style="padding:16px;text-align:center;color:#888;font-style:italic;">No calls with difficulties today. ✨</td></tr>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f0f0f0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f0f0;padding:32px 0;">
    <tr><td align="center">
      <table width="700" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- HEADER -->
        <tr><td style="background:${BRAND_PRIMARY};padding:24px 32px;">
          <img src="${SELF_BASE_URL}/logo" alt="${COMPANY_NAME}" height="48" style="display:block;margin-bottom:4px;" />
          <p style="margin:4px 0 0;font-size:13px;color:#dec3cb;letter-spacing:0.04em;">DAILY CALL SUMMARY</p>
        </td></tr>
        <tr><td style="background:${BRAND_ACCENT};height:4px;"></td></tr>

        <!-- DATE + STATS -->
        <tr><td style="padding:28px 32px 0;">
          <p style="margin:0;font-size:18px;color:#060908;font-weight:600;">${escapeHtml(dateLabel)}</p>
          <p style="margin:8px 0 0;font-size:14px;color:#555;line-height:1.6;">
            <strong>${total}</strong> inbound call${total === 1 ? '' : 's'} today &middot;
            <strong style="color:#0a7;">${messages.length}</strong> message${messages.length === 1 ? '' : 's'} captured &middot;
            <strong style="color:${difficulties.length ? '#c33' : '#888'};">${difficulties.length}</strong> flagged for difficulty
          </p>
        </td></tr>

        <!-- MESSAGES -->
        <tr><td style="padding:24px 32px 0;">
          <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#060908;text-transform:uppercase;letter-spacing:0.05em;">Messages received</p>
          <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e8e8e8;border-radius:6px;overflow:hidden;">
            <thead><tr style="background:${BRAND_PRIMARY};color:#fff;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">
              <th style="padding:8px 16px;text-align:left;width:70px;">Time</th>
              <th style="padding:8px 16px;text-align:left;width:140px;">Caller</th>
              <th style="padding:8px 16px;text-align:left;width:120px;">For</th>
              <th style="padding:8px 16px;text-align:left;">Topic</th>
            </tr></thead>
            <tbody>${messageRows}</tbody>
          </table>
        </td></tr>

        <!-- DIFFICULTIES -->
        <tr><td style="padding:24px 32px 0;">
          <p style="margin:0 0 12px;font-size:13px;font-weight:600;color:#c33;text-transform:uppercase;letter-spacing:0.05em;">⚠ Calls flagged for difficulty</p>
          <table cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #f0d8d8;border-radius:6px;overflow:hidden;">
            <thead><tr style="background:#fbe8e8;color:#c33;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;">
              <th style="padding:8px 16px;text-align:left;width:70px;">Time</th>
              <th style="padding:8px 16px;text-align:left;width:140px;">From</th>
              <th style="padding:8px 16px;text-align:left;">Reasons</th>
              <th style="padding:8px 16px;text-align:left;width:160px;">Outcome</th>
            </tr></thead>
            <tbody>${difficultyRows}</tbody>
          </table>
        </td></tr>

        ${other.length > 0 ? `
        <tr><td style="padding:24px 32px 0;">
          <p style="margin:0 0 8px;font-size:12px;color:#888;">
            ${other.length} other call${other.length === 1 ? '' : 's'} not classified above (e.g. hit the system-down fallback, or no clear outcome).
          </p>
        </td></tr>` : ''}

        <!-- FOOTER -->
        <tr><td style="padding:32px;border-top:1px solid #e8e8e8;margin-top:24px;">
          <p style="margin:0;font-size:12px;color:#aaa;line-height:1.5;">
            Generated by the ${COMPANY_NAME} AI Receptionist.<br>
            Sent from <a href="mailto:${SENDER_EMAIL}" style="color:${BRAND_ACCENT};">${SENDER_EMAIL}</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Run the daily summary: fetch calls, classify, send email.
 * Returns { sent: bool, stats: {...} }.
 */
async function runDailySummary({ daysBack = 0 } = {}) {
  // Compute "midnight (start of day) in SUMMARY_TIMEZONE" properly across DST.
  // Approach: read the current wall-clock hour/min/sec in target timezone via
  // Intl.DateTimeFormat parts, subtract that elapsed-since-midnight from now,
  // then subtract daysBack additional days. Avoids the UTC-midnight bug the v1
  // had (which made "today" run from 7pm yesterday → 7pm today during CDT).
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SUMMARY_TIMEZONE,
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hh = parseInt(parts.find(p => p.type === 'hour').value, 10) || 0;
  const mm_ = parseInt(parts.find(p => p.type === 'minute').value, 10) || 0;
  const ss = parseInt(parts.find(p => p.type === 'second').value, 10) || 0;
  const msSinceLocalMidnight = ((hh * 3600) + (mm_ * 60) + ss) * 1000;
  const since = new Date(now.getTime() - msSinceLocalMidnight - (daysBack * 24 * 3600 * 1000));
  const until = new Date(since.getTime() + 24 * 60 * 60 * 1000);
  // Fetch a slightly wider Bland window than `since` so we don't miss boundary calls
  const safeSince = new Date(since.getTime() - 60 * 60 * 1000);  // 1h before window start

  console.log(`[DAILY_SUMMARY] Fetching calls since ${safeSince.toISOString()} (window: ${since.toLocaleDateString('en-US',{timeZone:SUMMARY_TIMEZONE})})`);

  // Fetch list
  const allCalls = await fetchBlandInboundCalls({ since: safeSince, until: now });

  // Filter to today's window (in target timezone)
  const todaysCalls = allCalls.filter(c => {
    const t = new Date(c.created_at);
    return t >= since && t < until;
  });

  console.log(`[DAILY_SUMMARY] ${todaysCalls.length} calls in target window (of ${allCalls.length} fetched)`);

  // Pull detail for each + classify
  const messages = [], difficulties = [], other = [];
  for (const c of todaysCalls) {
    let detail;
    try {
      detail = await fetchBlandCallDetail(c.call_id);
    } catch (e) {
      console.warn(`[DAILY_SUMMARY] couldn't fetch detail for ${c.call_id}: ${e.message}`);
      continue;
    }
    const { kind, reasons, summary, messageStillSent } = classifyCall(detail);
    // Pull caller name + COMPANY + consultant from transcript heuristically.
    // Bland's structured fields don't expose these so we regex out of the
    // concatenated transcript. False-positive risk is low because the prompts
    // train Riley to elicit these in predictable phrasings.
    const transcript = detail.concatenated_transcript || '';
    const callerMatch =
      transcript.match(/this is\s+([A-Z][a-z]+(?:[\s'-][A-Z][a-z]+){1,2})/i) ||
      transcript.match(/it'?s\s+([A-Z][a-z]+(?:[\s'-][A-Z][a-z]+){1,2})/i);
    // Company: "from <Co>" or "with <Co>" or "calling from <Co>" — stop at common
    // sentence-terminators or transitional words to avoid grabbing the whole rest.
    const companyMatch =
      transcript.match(/(?:I'm\s+with|calling\s+from|i'?m\s+from|from)\s+([A-Z][\w&. ]*?)(?=[,.!?]|\s+(?:calling|here|about|because|for|hi|hello|to\b|and\b)|\s*$)/i);
    const consultantMatch =
      transcript.match(/call(?:ing)? for\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i) ||
      transcript.match(/(?:speak with|connect me with|message for)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/i) ||
      transcript.match(/let\s+([A-Z][a-z]+)\s+know/i);
    const entry = {
      callId: c.call_id,
      created_at: c.created_at,
      callerNumber: c.from || 'unknown',
      caller: callerMatch ? callerMatch[1].trim() : (c.from || 'unknown'),
      callerCompany: companyMatch ? companyMatch[1].trim() : null,
      consultant: consultantMatch ? consultantMatch[1] : '—',
      summary: summary || '',
      reasons,
      messageStillSent,
    };
    if (kind === 'message') messages.push(entry);
    else if (kind === 'difficulty') difficulties.push(entry);
    else other.push(entry);
  }

  // Compose + send email
  const html = composeDailySummaryHTML({
    dateLabel: fmtDate(since, SUMMARY_TIMEZONE),
    messages, difficulties, other,
    total: todaysCalls.length,
  });

  const subject = `📋 ${COMPANY_NAME} daily call summary — ${since.toLocaleDateString('en-US',{timeZone:SUMMARY_TIMEZONE,month:'short',day:'numeric'})} (${todaysCalls.length} call${todaysCalls.length === 1 ? '' : 's'})`;

  const token = await getGraphToken();
  await axios.post(
    `https://graph.microsoft.com/v1.0/users/${SENDER_EMAIL}/sendMail`,
    {
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: SUMMARY_RECIPIENT } }],
      },
      saveToSentItems: true,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
  );

  console.log(`[DAILY_SUMMARY] sent to ${SUMMARY_RECIPIENT}: ${todaysCalls.length} total / ${messages.length} messages / ${difficulties.length} difficulties / ${other.length} other`);
  return { sent: true, stats: { total: todaysCalls.length, messages: messages.length, difficulties: difficulties.length, other: other.length } };
}

// ── ADMIN endpoint to trigger the summary on-demand (testing or backfill) ──
// Fire-and-forget: returns 202 immediately, runs in background. Necessary
// because runDailySummary fetches detail for every call in the window, which
// can take 30-60+ seconds and Railway's HTTP edge times out the request first
// (saw 502s on test trigger when window had ~100 calls).
app.post('/daily-summary', requireAdminKey, (req, res) => {
  const daysBack = Math.min(parseInt(req.body?.daysBack || '0', 10) || 0, 30);
  res.status(202).json({
    accepted: true,
    message: `Daily summary running in background; email will arrive at ${SUMMARY_RECIPIENT} when complete (typically 30-90s).`,
    daysBack,
  });
  // Run in background; logs go to stdout so we can grep them in Railway logs.
  runDailySummary({ daysBack })
    .then(r => console.log(`[DAILY_SUMMARY] manual trigger completed:`, JSON.stringify(r.stats)))
    .catch(e => console.error('[DAILY_SUMMARY] manual trigger failed:', e.response?.data || e.message));
});

// ── Cron: fire daily at 8pm Central ──
// Cron expression: '0 20 * * *' = 20:00 (8pm) every day. The `timezone` option
// makes node-cron interpret that local-time correctly across DST.
if (BLAND_API_KEY) {
  cron.schedule('0 20 * * *', async () => {
    console.log('[DAILY_SUMMARY] cron firing — 8pm Central');
    try {
      await runDailySummary();
    } catch (e) {
      console.error('[DAILY_SUMMARY] cron run failed:', e.message);
    }
  }, { timezone: SUMMARY_TIMEZONE });
  console.log(`Daily summary cron scheduled: 20:00 ${SUMMARY_TIMEZONE} → ${SUMMARY_RECIPIENT}`);
} else {
  console.warn('Daily summary cron NOT scheduled: BLAND_API_KEY not set');
}

app.listen(PORT, () => console.log(`${COMPANY_NAME} client lookup running on port ${PORT}`));
module.exports = app;