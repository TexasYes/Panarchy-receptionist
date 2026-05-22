# panarchy-receptionist — Active Plan

## 🎯 Current state (2026-05-22)

**LIVE in production.** Panarchy receptionist is taking real calls on `+12513335665`. Riley answers, looks up employees from the Panarchy Google Sheet, takes messages, and emails them to the consultant with Panarchy-branded HTML (Black + Red, reversed logo). Same Bland workspace as Dialog; both numbers coexist.

**One known cosmetic carryover (accepted, not blocking):** outgoing emails are sent FROM `receptionist@dialoggroup.com` (Dialog's MS Graph creds reused) — the email BODY is properly Panarchy-branded but the SMTP From header still says dialoggroup.com. Bob owns both domains; deemed acceptable 2026-05-22. To fix in a future session, do the Azure app registration on the panarchy.io tenant (Mail.Send permission, admin consent) and update the four `MS_*` env vars in Railway.

## ✅ Done (this session)
- Cloned `dialog-receptionist/` → `panarchy-receptionist/` (excluding state, secrets, node_modules, .git)
- Rebranded `index.js`: COMPANY_NAME / BRAND_PRIMARY / BRAND_ACCENT env-driven; SENDER_EMAIL → `receptionist@panarchy.io`; SUMMARY_RECIPIENT → `bobgutermuth@panarchy.io`; PRODUCTION_NUMBER → `+12513335665`; Twilio TwiML voice line; conference name; health-check service name
- `FALLBACK_EMPLOYEES` = 5 Panarchy staff (Bob with phone, Vince/Mark/Colleen/Rhonda phone TODO)
- `VIP_CLIENTS` = []
- `.bland-riley-production.json` rewritten — "Panarchy" instead of "Dialog", `tools: []` placeholder, `bobgutermuth@panarchy.io` as no-match fallback
- `prompts/riley-bland-prompt.md` rebranded
- `.env.example` rewritten with Panarchy defaults + section ordering by importance
- `package.json` name + description updated
- `CLAUDE.md` rewritten (50 lines instead of 335 — points to dialog-receptionist for shared knowledge)

## ✅ Done 2026-05-21 / 2026-05-22 (bringing this online)

1. Brand assets — `logo.png` = `docs/Panarchy_logo_reversed2.png`; `BRAND_PRIMARY=#000000` / `BRAND_ACCENT=#EF4124` per `docs/Panarchy_Brand_Guidelines.md`
2. Google Sheet `1iPluCrn4fVbjtuQKJdLz0lj89WfHW-b4uv2yBfablH8` (tab `Sheet1`, columns `#, name, phone, gender, email, conditions`) — Bob populated all 5 staff including gender
3. Railway service `panarchy-receptionist-production.up.railway.app` running, env vars set (including renamed `WEBHOOK_SHARED_SECRET`)
4. Bland tools created via `scripts/run-setup-bland.sh` — IDs saved to `.bland-tool-ids.json` and wired into `.bland-riley-production.json`
5. Inbound prompt pushed to `+12513335665` via `scripts/run-push-inbound.sh`
6. Twilio voice URL manually set to the shared Bland inbound webhook (same encrypted_key Dialog uses — see "Bland routing model" below)
7. Live smoke-tested 2026-05-22 — Riley answered, took a message, email delivered

## 🔲 Open / nice-to-haves

- **Rhonda Bradford's phone number** — still empty in `FALLBACK_EMPLOYEES` (and presumably in the Google Sheet). Lookups for her will return phone=""; Riley still takes a message and emails her at `RhondaBradford@panarchy.io`.
- **Azure app registration on panarchy.io tenant** — optional rebrand of the outgoing email sender from `receptionist@dialoggroup.com` to `receptionist@panarchy.io`. Email body is already Panarchy-branded; this would only change the SMTP From header. Step-by-step in this session's transcript if/when wanted.
- **Voice quality** — accepted as inherent to Bland's `enhanced` model. Same constraints as Dialog. Don't chase further unless callers complain.
- **Daily summary cron at 8pm CT** — already wired; will fire automatically against Panarchy's calls. Verify a few summaries land cleanly over the next week.

## 🧠 Inherited gotchas (from dialog-receptionist, still apply)

- **`WEBHOOK_SHARED_SECRET`** is the Bland-tool ↔ Railway shared secret. Renamed from Dialog's `VAPI_SERVER_SECRET` since Panarchy is greenfield on Bland (no Vapi involvement). If you ever port code back to Dialog, that env var name still differs there.
- **Bland's WAF**: Node TLS fingerprint blocked → `setup-bland-agent.js` shells out to `curl` and uses a cookie jar. Don't rewrite this.
- **`block_interruptions: true` blocks legitimate caller responses** — keep null/false.
- **`interruption_threshold: 100` cuts off Riley's greeting** — keep at 1500.
- **`voice_settings.speed: 0.7`** is Dialog's caller-tested value; revisit if Panarchy callers complain.
- **Railway uses `npm ci`** — keep `package-lock.json` in sync with `package.json` or deploy fails.
- **Long-running endpoints (`/daily-summary`) must return 202 + process in background** — Railway edge timeout otherwise kills the request.

## 🔄 Deferred (carried over from Dialog's open items)

- **Warm transfer with accept/reject** — same Bland-instruction-following ceiling applies. Don't attempt for Panarchy until Dialog has shipped it.
- **VIP client list** — empty for Panarchy by design. Add if/when a Panarchy CRM lands.
- **Vapi / LiveKit infrastructure** — Dialog kept those configured for emergency rollback. Panarchy starts greenfield on Bland; we can ignore those code paths unless reviving.

## End of session protocol

Before `/clear`:
1. Update this `PLAN.md` (move items between sections).
2. Update `CLAUDE.md` with any new conventions discovered.
3. Remind the user to rename the conversation in the Claude Code sidebar.
