#!/usr/bin/env bash
# run-byot-twilio.sh — connect a Twilio account to Bland and link
# +12513335665 to it, per Bland docs:
#   https://docs.bland.ai/tutorials/custom-twilio
#   https://docs.bland.ai/api-v1/post/accounts
#   https://docs.bland.ai/api-v1/post/inbound-insert
#
# Two-step API flow:
#   1. POST /v1/accounts          → returns encrypted_key tied to the Twilio acct
#   2. POST /v1/inbound           → uploads the phone number with that key
# Then re-push the snapshot to restore prompt/tools on the number.
#
# Idempotent re-uses: if .bland-encrypted-key already exists locally, skip
# step 1 and go straight to step 2.
#
# Usage:  bash scripts/run-byot-twilio.sh

set -e
cd "$(dirname "$0")/.."

NUMBER="+12513335665"
KEY_FILE=".bland-encrypted-key"

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

PRETTIFY() {
  python3 -m json.tool 2>/dev/null || cat
}

prompt_hidden BLAND_API_KEY 'Paste BLAND_API_KEY (hidden): '
if [ -z "$BLAND_API_KEY" ]; then
  echo "ERROR: no BLAND_API_KEY entered. Aborting."
  exit 1
fi

# ─── STEP 1: Create encrypted_key (or reuse existing) ────────────────────────
if [ -f "$KEY_FILE" ] && [ -s "$KEY_FILE" ]; then
  ENCRYPTED_KEY=$(cat "$KEY_FILE")
  echo
  echo "════════════════════════════════════════════════════"
  echo "STEP 1: Reusing existing encrypted_key from $KEY_FILE"
  echo "(delete that file if you want to issue a fresh one)"
  echo "════════════════════════════════════════════════════"
else
  prompt_hidden TWILIO_AC_SID     'Paste Twilio Account SID, must start with AC... (hidden): '
  prompt_hidden TWILIO_AUTH_TOKEN 'Paste Twilio Auth Token (hidden): '

  if [[ ! "$TWILIO_AC_SID" =~ ^AC[0-9a-fA-F]{32}$ ]]; then
    echo
    echo "ERROR: TWILIO_AC_SID doesn't look like a valid Twilio Account SID."
    echo "Expected: AC followed by 32 hex chars. Got: ${TWILIO_AC_SID:0:4}..."
    unset BLAND_API_KEY TWILIO_AC_SID TWILIO_AUTH_TOKEN
    exit 1
  fi

  echo
  echo "════════════════════════════════════════════════════"
  echo "STEP 1: POST /v1/accounts  (creating encrypted_key)"
  echo "════════════════════════════════════════════════════"

  HTTP1=$(curl -sS -o /tmp/bland-byot-step1.json -w "%{http_code}" \
    -X POST "https://api.bland.ai/v1/accounts" \
    -H "authorization: $BLAND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"account_sid\":\"$TWILIO_AC_SID\",\"auth_token\":\"$TWILIO_AUTH_TOKEN\"}")
  echo "HTTP $HTTP1"
  PRETTIFY < /tmp/bland-byot-step1.json
  echo

  ENCRYPTED_KEY=$(python3 -c "import json; print(json.load(open('/tmp/bland-byot-step1.json')).get('encrypted_key',''))")

  if [ -z "$ENCRYPTED_KEY" ]; then
    echo "ERROR: response did not contain encrypted_key. Aborting."
    unset BLAND_API_KEY TWILIO_AC_SID TWILIO_AUTH_TOKEN
    exit 1
  fi

  echo "$ENCRYPTED_KEY" > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "✓ encrypted_key saved to $KEY_FILE (gitignored, mode 600)"
  unset TWILIO_AC_SID TWILIO_AUTH_TOKEN
fi

# ─── STEP 2: Upload phone number with the encrypted_key ──────────────────────
echo
echo "════════════════════════════════════════════════════"
echo "STEP 2: POST /v1/inbound  (uploading $NUMBER with encrypted_key)"
echo "════════════════════════════════════════════════════"

HTTP2=$(curl -sS -o /tmp/bland-byot-step2.json -w "%{http_code}" \
  -X POST "https://api.bland.ai/v1/inbound" \
  -H "authorization: $BLAND_API_KEY" \
  -H "encrypted_key: $ENCRYPTED_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"numbers\":[\"$NUMBER\"]}")
echo "HTTP $HTTP2"
PRETTIFY < /tmp/bland-byot-step2.json
echo

# ─── STEP 3: Re-push the snapshot to restore prompt + tools on the number ───
echo
echo "════════════════════════════════════════════════════"
echo "STEP 3: POST /v1/inbound/$NUMBER  (re-applying prompt + tools)"
echo "════════════════════════════════════════════════════"

HTTP3=$(curl -sS -o /tmp/bland-byot-step3.json -w "%{http_code}" \
  -X POST "https://api.bland.ai/v1/inbound/$NUMBER" \
  -H "authorization: $BLAND_API_KEY" \
  -H "Content-Type: application/json" \
  -d @.bland-riley-production.json)
echo "HTTP $HTTP3"
PRETTIFY < /tmp/bland-byot-step3.json
echo

# ─── STEP 4: Verify ──────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════"
echo "STEP 4: Verifying — does $NUMBER now have account_sid set?"
echo "════════════════════════════════════════════════════"
curl -sS "https://api.bland.ai/v1/inbound/$NUMBER" \
  -H "authorization: $BLAND_API_KEY" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); keep=("phone_number","account_sid","webhook","skip_url_update","first_sentence"); print(json.dumps({k:d.get(k) for k in keep}, indent=2))'
echo

unset BLAND_API_KEY

echo
echo "════════════════════════════════════════════════════"
echo "Done."
echo "  - If account_sid is now populated above, BYOT is complete."
echo "  - Bland should have auto-pushed its webhook URL into Twilio."
echo "  - Verify in Twilio Console → $NUMBER → Voice Configuration."
echo "    Expected: https://server.aws.*.bland.ai/incoming?encrypted_key=...&user_id=10f415ac-...&..."
echo "════════════════════════════════════════════════════"
