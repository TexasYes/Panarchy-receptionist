#!/usr/bin/env bash
# run-restore-model.sh — switch Riley's model from gpt-4o-realtime back to
# gpt-4o (chat completions + TTS), which is the working configuration.
#
# Usage:  bash scripts/run-restore-model.sh

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
echo "Step 1/2: backup all assistants first"
echo "════════════════════════════════════════════════════"
node scripts/backup-assistants.js

echo
echo "════════════════════════════════════════════════════"
echo "Step 2/2: switch Riley's model back to gpt-4o"
echo "════════════════════════════════════════════════════"
node scripts/restore-riley-model.js

unset VAPI_PRIVATE_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo
echo "  Riley is back on gpt-4o (chat completions + TTS)."
echo "  Realtime API is great for some workloads but not for ours —"
echo "  it doesn't handle multi-tool flows or our prompt complexity well."
echo
echo "  Test call: same as before."
echo "════════════════════════════════════════════════════"
