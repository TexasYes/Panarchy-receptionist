# Panarchy AI Receptionist — Claude Code Context

## Project Overview
AI receptionist for **Panarchy**. Cloned from [dialog-receptionist](../dialog-receptionist/) on 2026-05-21. Same Express webhook + Bland.ai prompt-mode Riley pattern — identifies caller, looks up the staff member they're asking for, takes a message, emails it. Message-only (warm transfer deferred — same as Dialog).

Most architectural decisions, gotchas, and rationale live in the source repo's [CLAUDE.md](../dialog-receptionist/CLAUDE.md) and [PLAN.md](../dialog-receptionist/PLAN.md). This file captures only what differs for Panarchy.

## Stack (target — most pieces are TODO at clone time)

| Layer | Provider | Details |
|---|---|---|
| Orchestration | Bland.ai (prompt mode) | TODO: push `.bland-riley-production.json` to inbound config on `+12513335665` |
| Voice TTS/STT | Bland BTTS | `voice_settings.speed: 0.7`, default Bland voice (female) |
| Telephony | Twilio (BYOT to Bland) | Repurposed `+12513335665` (was Dialog's Vapi-era number, currently stale per Dialog PLAN.md) |
| Webhook server | Railway | TODO: create new Railway service `panarchy-receptionist-webhook` |
| Employee directory | Google Sheet | TODO: create new sheet; set `GOOGLE_SHEET_ID` in Railway env |
| Email | Microsoft Graph + SMTP fallback | Sends from `receptionist@panarchy.io` (TODO: Azure app reg on panarchy.io tenant) |
| Daily summary | 8pm CT cron → `bobgutermuth@panarchy.io` | Same `node-cron` pattern as Dialog |

## What's Panarchy-specific in this repo
- `index.js`
  - `COMPANY_NAME` / `BRAND_PRIMARY` / `BRAND_ACCENT` env-driven (defaults to Panarchy Black `#000000` + Red `#EF4124` per `docs/Panarchy_Brand_Guidelines.md`)
  - `SENDER_EMAIL` defaults to `receptionist@panarchy.io`
  - `SUMMARY_RECIPIENT` defaults to `bobgutermuth@panarchy.io`
  - `PRODUCTION_NUMBER` defaults to `+12513335665`
  - `FALLBACK_EMPLOYEES` = 5 staff (Bob, Vince, Mark, Colleen, Rhonda) — phones still TODO
  - `VIP_CLIENTS` = empty (no priority list at launch)
- `.bland-riley-production.json` — "Panarchy" instead of "Dialog"; `tools: []` (must run `setup-bland-agent.js` to create Panarchy-specific tool IDs)
- `prompts/riley-bland-prompt.md` — rebranded
- `.env.example` — Panarchy defaults
- `logo.png` — set to `docs/Panarchy_logo_reversed2.png` (white wordmark + red bird, on dark BG). Swap for a different variant if email background changes.

## What's still Dialog-flavored (intentional carryover)
- All `scripts/` (`setup-bland-agent.js`, `vapi-audit.js`, etc.) — same code paths, just need different env vars at run-time
- `legal.js`, `sms-receptionist.js` — Dialog-era modules, dormant; ignore unless reviving
- Filenames like `scripts/setup-bland-pathway.js` reference Dialog by name in code comments — non-functional

## Setup checklist (run in this order)

1. **Brand assets** — DONE in this clone: `logo.png` is the reversed Panarchy logo; `BRAND_PRIMARY` / `BRAND_ACCENT` default to Black + Red. Override if Panarchy adopts a new palette.
2. **Microsoft Graph app reg** (panarchy.io tenant) — create Azure app registration; grant Application permission `Mail.Send`; admin-consent; create `receptionist@panarchy.io` mailbox. Save tenant/client/secret to `.env`.
3. **Google Sheet** — create new sheet with columns `#, name, phone, gender, email, conditions`, tab named `Sheet1`. Share read-access with the Google API key. Set `GOOGLE_SHEET_ID` in `.env`.
4. **Twilio number** — verify `+12513335665` is still owned in Twilio. If yes, unset its current voice URL (still pointing at deleted LiveKit TwiML Bin per Dialog PLAN.md).
5. **Railway service** — create new project; connect to GitHub repo (TBD); paste env vars from `.env`. Note the generated `*.up.railway.app` hostname and set as `SELF_BASE_URL`.
6. **Bland setup** — run `BLAND_API_KEY=... WEBHOOK_SHARED_SECRET=... SELF_BASE_URL=https://... node scripts/setup-bland-agent.js`. This creates Panarchy-specific `lookup_employee_email` and `send_message_email` tool IDs in Bland. Save the returned IDs into `.bland-riley-production.json` under `tools: [...]`.
7. **Buy Panarchy number in Bland** — Bland Dashboard → Phone Numbers → add `+12513335665` via BYOT (Twilio API SID/secret). Twilio's voice URL auto-flips to Bland's inbound.
8. **Push the inbound config**:
   ```bash
   curl -X POST "https://api.bland.ai/v1/inbound/+12513335665" \
     -H "authorization: $BLAND_API_KEY" \
     -H "Content-Type: application/json" \
     -d @.bland-riley-production.json
   ```
9. **Test** — call `+12513335665`. Verify Riley greets, takes a message, email lands at `bobgutermuth@panarchy.io`.

## Employee Directory (5 staff at launch)

Hardcoded `FALLBACK_EMPLOYEES` in `index.js`; Google Sheet (TODO) will override at runtime with 60s TTL.

| Name | Email | Phone |
|---|---|---|
| Bob Gutermuth | bobgutermuth@panarchy.io | +15129255665 |
| Vince DiBianca | vincedibianca@panarchy.io | +16093061155 |
| Mark Thompson | MarkThompson@panarchy.io | +15129684381 |
| Colleen Brown | ColleenBrown@panarchy.io | +12063910085 |
| Rhonda Bradford | RhondaBradford@panarchy.io | _TODO_ |

## End of session protocol
1. Update `PLAN.md` with what was completed / what's still open.
2. Update this `CLAUDE.md` with any new conventions discovered.
3. Remind the user to rename the conversation in the Claude Code sidebar before clearing.
