#!/usr/bin/env bash
# run-fix-send-message-body.sh — single-command wrapper for the
# send_message_email body-template fix.
#
# Usage:  bash scripts/run-fix-send-message-body.sh

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
echo "Step 1/2: backup all assistants & tools first"
echo "════════════════════════════════════════════════════"
node scripts/backup-assistants.js

echo
echo "════════════════════════════════════════════════════"
echo "Step 2/2: patch send_message_email tool body template"
echo "════════════════════════════════════════════════════"
node scripts/patch-send-message-body.js

unset VAPI_PRIVATE_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo
echo "  Next: ONE test call:"
echo "    1. Call +15126979425 from a number Riley doesn't recognize"
echo "    2. Say: 'I'd like to leave a message for Bob'"
echo "    3. Give your name, company, callback, reason"
echo "    4. Hang up after Riley confirms"
echo "    5. Save the new call log JSON to logs/"
echo "    6. Tell Claude it's there"
echo "════════════════════════════════════════════════════"
