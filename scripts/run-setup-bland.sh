#!/usr/bin/env bash
# run-setup-bland.sh — create or update the Bland.ai inbound voice agent
# from the canonical prompt at prompts/riley-bland-prompt.md.
#
# Idempotent: re-running PATCHes the existing agent + tools (the agent_id is
# saved to .bland-agent-id locally, gitignored).
#
# Usage:  bash scripts/run-setup-bland.sh

set -e
cd "$(dirname "$0")/.."

# Source .env if present so secrets (BLAND_API_KEY, WEBHOOK_SHARED_SECRET) auto-load.
if [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "$BLAND_API_KEY" ]; then
  printf 'Paste BLAND_API_KEY (input hidden), then press Enter: '
  stty -echo
  read BLAND_API_KEY
  stty echo
  printf '\n'
  export BLAND_API_KEY
fi

if [ -z "$BLAND_API_KEY" ]; then
  echo "ERROR: no BLAND_API_KEY entered. Aborting."
  exit 1
fi

if [ -z "$WEBHOOK_SHARED_SECRET" ]; then
  printf 'Paste WEBHOOK_SHARED_SECRET (the shared secret Bland tools send as Authorization to Railway; input hidden): '
  stty -echo
  read WEBHOOK_SHARED_SECRET
  stty echo
  printf '\n'
  export WEBHOOK_SHARED_SECRET
fi

if [ -z "$WEBHOOK_SHARED_SECRET" ]; then
  echo "ERROR: no WEBHOOK_SHARED_SECRET entered. Tools would be created with no auth header — aborting."
  exit 1
fi

echo
echo "════════════════════════════════════════════════════"
echo "Setting up Bland tools (+ stub agent)"
echo "RAILWAY_BASE: ${SELF_BASE_URL:-https://panarchy-receptionist-production.up.railway.app}"
echo "════════════════════════════════════════════════════"
node scripts/setup-bland-agent.js

unset BLAND_API_KEY WEBHOOK_SHARED_SECRET
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo
echo "  Tool IDs saved to .bland-tool-ids.json (gitignored)."
echo "  Next:"
echo "  1. Copy the two TL-... IDs from .bland-tool-ids.json into"
echo "     .bland-riley-production.json under \"tools\": [\"TL-...\", \"TL-...\"]"
echo "  2. Add +12513335665 to Bland via BYOT (Phone Numbers → Add → BYO Twilio)"
echo "  3. Push the inbound config:"
echo "       curl -X POST https://api.bland.ai/v1/inbound/+12513335665 \\"
echo "         -H \"authorization: \$BLAND_API_KEY\" \\"
echo "         -H \"Content-Type: application/json\" \\"
echo "         -d @.bland-riley-production.json"
echo "════════════════════════════════════════════════════"
