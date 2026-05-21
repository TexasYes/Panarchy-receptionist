#!/usr/bin/env bash
# run-push-prompt.sh — push the canonical Riley system prompt from
# `prompts/riley-system-prompt.md` to Vapi. Backs up first.
#
# Use this whenever you edit the prompt file. Repo is the source of truth;
# Vapi is downstream.
#
# Usage:  bash scripts/run-push-prompt.sh

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
echo "Step 2/2: push prompts/riley-system-prompt.md to Vapi"
echo "════════════════════════════════════════════════════"
node scripts/push-riley-prompt.js

unset VAPI_PRIVATE_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo
echo "  Riley's prompt in Vapi now matches the repo file."
echo
echo "  Test call:"
echo "    1. Call +15126979425 from a number Riley doesn't recognize"
echo "    2. Say: 'I'd like to leave a message for Bob'"
echo "    3. Give name, company, callback (or just confirm caller ID), reason"
echo "    4. Save the new call log JSON to logs/"
echo "    5. Tell Claude it's there"
echo "════════════════════════════════════════════════════"
