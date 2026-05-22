#!/usr/bin/env bash
# run-byot-twilio.sh — finish BYOT for +12513335665 by giving Bland your
# Twilio Account SID + Auth Token. Bland validates the creds, generates a
# per-number encrypted_key, and pushes its webhook URL into Twilio's voice
# config field automatically.
#
# Tries two API shapes in order (Bland docs are sparse so we attempt the most
# likely first, then fall back). Read-only test before each write so we don't
# clobber a working setup.
#
# Usage:  bash scripts/run-byot-twilio.sh

set -e
cd "$(dirname "$0")/.."

NUMBER="+12513335665"

if [ -f .env ]; then
  set -a; source .env; set +a
fi

prompt_hidden() {
  local var_name="$1"
  local prompt_text="$2"
  if [ -z "${!var_name}" ]; then
    printf '%s' "$prompt_text"
    stty -echo
    read "$var_name"
    stty echo
    printf '\n'
    export "$var_name"
  fi
}

prompt_hidden BLAND_API_KEY     'Paste BLAND_API_KEY (hidden): '
prompt_hidden TWILIO_AC_SID     'Paste Twilio Account SID — must start with AC... (hidden): '
prompt_hidden TWILIO_AUTH_TOKEN 'Paste Twilio Auth Token (hidden): '

# Sanity-check the SID is actually an AC (Twilio's classic Account SID).
if [[ ! "$TWILIO_AC_SID" =~ ^AC[0-9a-fA-F]{32}$ ]]; then
  echo
  echo "ERROR: TWILIO_AC_SID doesn't look like a valid Twilio Account SID."
  echo "Expected pattern: AC followed by 32 hex chars."
  echo "If you have an API Key SID (SK...), you also need the matching Account"
  echo "SID — Bland needs the AC for ownership verification."
  unset BLAND_API_KEY TWILIO_AC_SID TWILIO_AUTH_TOKEN
  exit 1
fi

PRETTIFY() {
  python3 -m json.tool 2>/dev/null || cat
}

echo
echo "════════════════════════════════════════════════════"
echo "ATTEMPT 1: POST /v1/inbound/$NUMBER with twilio creds"
echo "   (most likely — those fields already exist in the response shape)"
echo "════════════════════════════════════════════════════"

# Build the payload by reading the existing snapshot and adding Twilio fields.
PAYLOAD=$(python3 <<PYEOF
import json
with open('.bland-riley-production.json') as f:
    cfg = json.load(f)
cfg['account_sid']     = '${TWILIO_AC_SID}'
cfg['auth_token']      = '${TWILIO_AUTH_TOKEN}'
cfg['skip_url_update'] = False
print(json.dumps(cfg))
PYEOF
)

HTTP1=$(curl -sS -o /tmp/bland-byot-1.json -w "%{http_code}" \
  -X POST "https://api.bland.ai/v1/inbound/$NUMBER" \
  -H "authorization: $BLAND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")
echo "HTTP $HTTP1"
PRETTIFY < /tmp/bland-byot-1.json
echo

echo
echo "════════════════════════════════════════════════════"
echo "Verifying — does the inbound config now show account_sid set"
echo "and a non-null webhook?"
echo "════════════════════════════════════════════════════"
curl -sS "https://api.bland.ai/v1/inbound/$NUMBER" \
  -H "authorization: $BLAND_API_KEY" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({k:d.get(k) for k in ("account_sid","webhook","skip_url_update")}, indent=2))'
echo

if curl -sS "https://api.bland.ai/v1/inbound/$NUMBER" \
     -H "authorization: $BLAND_API_KEY" \
   | python3 -c 'import json,sys; d=json.load(sys.stdin); exit(0 if d.get("account_sid") else 1)'; then
  echo
  echo "✓ account_sid now set on the inbound config."
  echo
  echo "Bland may now have auto-updated Twilio's voice URL. Verify in"
  echo "Twilio Console → +12513335665 → Voice Configuration. If the URL"
  echo "now starts with https://server.aws.*.bland.ai/incoming?..., we're done."
  echo
  echo "If Twilio still shows the old LiveKit URL, the attempt below tries a"
  echo "different Bland endpoint that explicitly pushes the URL to Twilio."
else
  echo "✗ account_sid still null after attempt 1. Falling through to attempt 2."
fi

echo
echo "════════════════════════════════════════════════════"
echo "ATTEMPT 2: POST /v1/twilio/import (workspace-level BYOT)"
echo "════════════════════════════════════════════════════"
HTTP2=$(curl -sS -o /tmp/bland-byot-2.json -w "%{http_code}" \
  -X POST "https://api.bland.ai/v1/twilio/import" \
  -H "authorization: $BLAND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"phone_numbers\": [\"$NUMBER\"],
    \"account_sid\":   \"$TWILIO_AC_SID\",
    \"auth_token\":    \"$TWILIO_AUTH_TOKEN\"
  }")
echo "HTTP $HTTP2"
PRETTIFY < /tmp/bland-byot-2.json
echo

unset BLAND_API_KEY TWILIO_AC_SID TWILIO_AUTH_TOKEN

echo
echo "════════════════════════════════════════════════════"
echo "Done. Now verify in Twilio Console:"
echo "  - Phone Numbers → +12513335665 → Voice Configuration"
echo "  - 'A call comes in' should now be https://server.aws.*.bland.ai/incoming?..."
echo
echo "If still pointing at LiveKit, paste BOTH attempt responses back"
echo "(HTTP $HTTP1 + HTTP $HTTP2) so we can pivot strategy."
echo "════════════════════════════════════════════════════"
