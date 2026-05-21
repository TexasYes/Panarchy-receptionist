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

# Source .env if present so secrets (BLAND_API_KEY, VAPI_SERVER_SECRET) auto-load.
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
  echo "ERROR: no key entered. Aborting."
  exit 1
fi

echo
echo "════════════════════════════════════════════════════"
echo "Setting up Bland agent + tools"
echo "════════════════════════════════════════════════════"
node scripts/setup-bland-agent.js

unset BLAND_API_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo
echo "  Next: assign an inbound phone number to the agent."
echo "  - If you've already imported +12513335665 via Bland's BYOT page,"
echo "    open the number in Bland → set inbound_agent to the agent_id above."
echo "  - If BYOT didn't work on the Start tier, fall back to the free"
echo "    Bland-managed number (Phone Numbers → Buy)."
echo "════════════════════════════════════════════════════"
