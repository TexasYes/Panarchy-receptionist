#!/usr/bin/env bash
# run-fix.sh — one-command wrapper for tonight's Riley fix sequence.
#   1. Backup all assistants (so we can roll back)
#   2. Detach the legacy `transferCall` tool from Riley
#   3. Run audit to confirm
#
# Prompts for VAPI_PRIVATE_KEY once, hidden. No quoting tricks needed.
#
# Usage:  bash scripts/run-fix.sh

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
echo "Step 1/3: backup all assistants to backups/"
echo "════════════════════════════════════════════════════"
node scripts/backup-assistants.js

echo
echo "════════════════════════════════════════════════════"
echo "Step 2/3: detach transferCall from Riley"
echo "════════════════════════════════════════════════════"
node scripts/detach-transfercall-from-riley.js

echo
echo "════════════════════════════════════════════════════"
echo "Step 3/3: audit (Riley's tools after the change)"
echo "════════════════════════════════════════════════════"
# grep -A 40 catches the assistant header + its tool list (max 40 lines should
# cover any realistic toolIds count). Simpler than awk range patterns.
node scripts/vapi-audit.js 2>&1 | grep -A 40 "Dialog Receptionist"

unset VAPI_PRIVATE_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo "  - Verify: 'transferCall' should NOT appear in Riley's tool list above."
echo "  - Next:   paste the 'Transfer rule' block into Riley's system prompt,"
echo "            then make a test call."
echo "════════════════════════════════════════════════════"
