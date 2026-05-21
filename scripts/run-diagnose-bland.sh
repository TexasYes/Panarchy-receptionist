#!/usr/bin/env bash
# run-diagnose-bland.sh — interrogate Bland's API for the current state of
# our Panarchy setup. Read-only.
#
# Reports:
#   1. Inbound config attached to +12513335665 (prompt, tools, voice settings)
#   2. Tool definitions for lookup_employee_email + send_message_email
#   3. List of phone numbers in the workspace
#
# Usage:  bash scripts/run-diagnose-bland.sh

set -e
cd "$(dirname "$0")/.."

NUMBER="+12513335665"

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

PRETTIFY() {
  python3 -m json.tool 2>/dev/null || cat
}

echo
echo "════════════════════════════════════════════════════"
echo "1. INBOUND CONFIG ON $NUMBER"
echo "   (does Bland have our prompt + tools attached to the number?)"
echo "════════════════════════════════════════════════════"
curl -sS "https://api.bland.ai/v1/inbound/$NUMBER" \
  -H "authorization: $BLAND_API_KEY" | PRETTIFY
echo

echo
echo "════════════════════════════════════════════════════"
echo "2. TOOL: lookup_employee_email"
echo "   (URL it calls + auth header)"
echo "════════════════════════════════════════════════════"
LOOKUP_ID=$(python3 -c "import json; print(json.load(open('.bland-tool-ids.json'))['lookup_employee_email'])" 2>/dev/null || echo "")
if [ -n "$LOOKUP_ID" ]; then
  curl -sS "https://api.bland.ai/v1/tools/$LOOKUP_ID" \
    -H "authorization: $BLAND_API_KEY" | PRETTIFY
else
  echo "(.bland-tool-ids.json not found locally — skipping)"
fi
echo

echo
echo "════════════════════════════════════════════════════"
echo "3. TOOL: send_message_email"
echo "════════════════════════════════════════════════════"
SEND_ID=$(python3 -c "import json; print(json.load(open('.bland-tool-ids.json'))['send_message_email'])" 2>/dev/null || echo "")
if [ -n "$SEND_ID" ]; then
  curl -sS "https://api.bland.ai/v1/tools/$SEND_ID" \
    -H "authorization: $BLAND_API_KEY" | PRETTIFY
else
  echo "(.bland-tool-ids.json not found locally — skipping)"
fi
echo

echo
echo "════════════════════════════════════════════════════"
echo "4. PHONE NUMBERS IN WORKSPACE"
echo "   (is +12513335665 actually listed?)"
echo "════════════════════════════════════════════════════"
curl -sS "https://api.bland.ai/v1/inbound" \
  -H "authorization: $BLAND_API_KEY" | PRETTIFY
echo

unset BLAND_API_KEY
echo
echo "════════════════════════════════════════════════════"
echo "Diagnostic complete. Paste the output back to triage."
echo "════════════════════════════════════════════════════"
