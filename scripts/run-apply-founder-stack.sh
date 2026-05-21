#!/usr/bin/env bash
# run-apply-founder-stack.sh — switch Riley to the Vapi-founder-recommended
# production stack: gpt-4.1 + Deepgram + ElevenLabs v3.
#
# Usage:  bash scripts/run-apply-founder-stack.sh

set -e
cd "$(dirname "$0")/.."

# Source .env if present so secrets (VAPI_PRIVATE_KEY, BLAND_API_KEY, etc.)
# auto-load. Keys passed inline (export VAR=… before invocation) override.
if [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "$VAPI_PRIVATE_KEY" ]; then
  printf 'Paste VAPI_PRIVATE_KEY (input hidden), then press Enter: '
  stty -echo
  read VAPI_PRIVATE_KEY
  stty echo
  printf '\n'
  export VAPI_PRIVATE_KEY
fi

if [ -z "$VAPI_PRIVATE_KEY" ]; then
  echo "ERROR: no key entered. Aborting."
  exit 1
fi

echo
echo "════════════════════════════════════════════════════"
echo "Step 1/2: backup all assistants first (safety net)"
echo "════════════════════════════════════════════════════"
node scripts/backup-assistants.js

echo
echo "════════════════════════════════════════════════════"
echo "Step 2/2: apply founder stack to Riley"
echo "         (gpt-4.1 + Deepgram + ElevenLabs v3)"
echo "════════════════════════════════════════════════════"
node scripts/apply-founder-stack.js

unset VAPI_PRIVATE_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo
echo "  Riley is on the founder-recommended stack."
echo "  Optional: pick a specific ElevenLabs voice in the Vapi dashboard"
echo "  (Riley → Voice tab → Voice). Sarah, Rachel, and Bella are common"
echo "  professional choices."
echo
echo "  Then test call: +15126979425"
echo "════════════════════════════════════════════════════"
