#!/usr/bin/env bash
# run-push-inbound.sh — push .bland-riley-production.json to Bland's inbound
# config for +12513335665. Idempotent: re-running overwrites.
#
# Usage:  bash scripts/run-push-inbound.sh

set -e
cd "$(dirname "$0")/.."

NUMBER="+12513335665"
SNAPSHOT=".bland-riley-production.json"

if [ ! -f "$SNAPSHOT" ]; then
  echo "ERROR: $SNAPSHOT not found in $(pwd). Aborting."
  exit 1
fi

# Sanity check: snapshot must have non-empty tools array — pushing an empty
# tools list disconnects Riley from her ability to look up employees or send
# email. Fail loudly before the API call.
TOOL_COUNT=$(python3 -c "import json; print(len(json.load(open('$SNAPSHOT')).get('tools', [])))")
if [ "$TOOL_COUNT" -lt 2 ]; then
  echo "ERROR: $SNAPSHOT has $TOOL_COUNT tools attached (expected 2)."
  echo "Run scripts/run-setup-bland.sh first, then copy the TL- IDs from"
  echo ".bland-tool-ids.json into $SNAPSHOT under tools[]."
  exit 1
fi

# Source .env if present so BLAND_API_KEY auto-loads.
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

echo
echo "════════════════════════════════════════════════════"
echo "Pushing $SNAPSHOT → Bland inbound config for $NUMBER"
echo "Tools attached: $TOOL_COUNT"
echo "════════════════════════════════════════════════════"

HTTP_STATUS=$(curl -sS -o /tmp/bland-push-response.json -w "%{http_code}" \
  -X POST "https://api.bland.ai/v1/inbound/$NUMBER" \
  -H "authorization: $BLAND_API_KEY" \
  -H "Content-Type: application/json" \
  -d @"$SNAPSHOT")

echo
echo "HTTP $HTTP_STATUS"
echo "Response:"
python3 -m json.tool /tmp/bland-push-response.json 2>/dev/null || cat /tmp/bland-push-response.json
echo

unset BLAND_API_KEY

if [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
  echo "════════════════════════════════════════════════════"
  echo "✓ Inbound config applied to $NUMBER."
  echo
  echo "  Smoke test: call $NUMBER from a separate phone."
  echo "  Riley should answer with the Panarchy greeting and take a message."
  echo "════════════════════════════════════════════════════"
else
  echo "════════════════════════════════════════════════════"
  echo "✗ Push failed (HTTP $HTTP_STATUS). Common causes:"
  echo "  - Number not yet in your Bland workspace (Phone Numbers → Add)"
  echo "  - BLAND_API_KEY belongs to a different workspace than the number"
  echo "  - Bland's WAF flagged the request (rare — retry once)"
  echo "════════════════════════════════════════════════════"
  exit 1
fi
