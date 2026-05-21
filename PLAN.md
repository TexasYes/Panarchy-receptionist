# panarchy-receptionist — Active Plan

## 🎯 Current state (2026-05-21)

**Local code clone complete; nothing deployed yet.** Files copied from `dialog-receptionist` and rebranded for Panarchy. The system will not handle any calls until the setup-checklist items in `CLAUDE.md` are run.

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

## 🔲 Open / next steps (in run-order)

1. **Get Rhonda Bradford's phone number** — last missing field in `FALLBACK_EMPLOYEES`. Vince / Mark / Colleen / Bob set 2026-05-21.
2. ~~Brand assets~~ — DONE: `logo.png` = `docs/Panarchy_logo_reversed2.png`; `BRAND_PRIMARY=#000000` / `BRAND_ACCENT=#EF4124` per `docs/Panarchy_Brand_Guidelines.md`.
3. **Azure app registration** for `panarchy.io` tenant — Mail.Send permission on `receptionist@panarchy.io` mailbox.
4. ~~Create Panarchy Google Sheet~~ — DONE: `1iPluCrn4fVbjtuQKJdLz0lj89WfHW-b4uv2yBfablH8`. Make sure tab is named `Sheet1` with columns `#, name, phone, gender, email, conditions` and share with the Google API key.
5. ~~Confirm Twilio still owns `+12513335665`~~ — DONE 2026-05-21 (Bob confirmed). Currently points at a deleted LiveKit TwiML Bin; voice URL gets unset automatically when Bland BYOTs the number.
6. **Create new Railway service** `panarchy-receptionist-webhook` connected to a new GitHub repo. Paste env vars from `.env`. Note the `*.up.railway.app` URL.
7. **Run `scripts/setup-bland-agent.js`** with Panarchy's env. This will:
   - Create new `lookup_employee_email` + `send_message_email` Bland tools pointing at the Panarchy Railway URL
   - Return new `TL-...` tool IDs — paste into `.bland-riley-production.json` `tools: [...]`
   - Create a Bland agent (we'll attach it to the inbound number in next step)
8. **Add `+12513335665` to Bland account** via BYOT. Twilio's voice URL flips to Bland's inbound automatically.
9. **Push the inbound config**:
   ```
   curl -X POST "https://api.bland.ai/v1/inbound/+12513335665" \
     -H "authorization: $BLAND_API_KEY" \
     -H "Content-Type: application/json" \
     -d @.bland-riley-production.json
   ```
10. **Smoke test** — call `+12513335665` from a separate phone, ask for Bob, leave a message. Verify email lands at `bobgutermuth@panarchy.io`.
11. **Enable daily summary cron** — already wired in `index.js` (8pm CT). Verify `BLAND_API_KEY` is set in Railway and trigger manually first: `POST /daily-summary` with `Authorization: Bearer $ADMIN_API_KEY`.

## 🧠 Inherited gotchas (from dialog-receptionist, still apply)

- **`HAPI_TOKEN` and `VAPI_SERVER_SECRET`** are different things; the latter is the Bland-tool ↔ Railway shared secret. Same name preserved for code-path parity.
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
