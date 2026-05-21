#!/usr/bin/env bash
# setup-livekit-sip.sh — configure LiveKit Cloud to accept inbound SIP calls
# from Twilio and dispatch them to our Riley agent.
#
# Creates two LiveKit objects (idempotent — re-running is safe):
#   1. SIP Inbound Trunk: accepts calls from Twilio's SIP gateway
#   2. SIP Dispatch Rule: spawns a room per call and dispatches our agent worker
#
# Requires the LiveKit CLI:  brew install livekit-cli
#
# Usage:  bash scripts/setup-livekit-sip.sh

set -e
cd "$(dirname "$0")/.."

if ! command -v lk >/dev/null 2>&1; then
  echo "ERROR: 'lk' CLI not found. Install with:  brew install livekit-cli"
  exit 1
fi

if [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "$LIVEKIT_URL" ] || [ -z "$LIVEKIT_API_KEY" ] || [ -z "$LIVEKIT_API_SECRET" ]; then
  echo "ERROR: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set in .env"
  exit 1
fi

# lk reads these env vars natively, so no extra flags needed
export LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET

TRUNK_FILE="/tmp/lk-inbound-trunk.json"
DISPATCH_FILE="/tmp/lk-dispatch-rule.json"

# 1. Inbound trunk — accepts calls from Twilio's SIP gateway. LiveKit requires
#    the trunk to be scoped to specific numbers OR auth credentials OR IP
#    allowlist (security: can't have a wide-open trunk). We scope by the
#    destination number — only calls dialed FROM +12513335665 are accepted.
#    Set TRUNK_NUMBERS env var to override (comma-separated E.164).
TRUNK_NUMBERS="${TRUNK_NUMBERS:-+12513335665}"
NUMBERS_JSON=$(python3 -c "import json,sys; print(json.dumps([n.strip() for n in '$TRUNK_NUMBERS'.split(',') if n.strip()]))")
cat > "$TRUNK_FILE" <<JSON
{
  "trunk": {
    "name": "Twilio inbound (Dialog receptionist)",
    "numbers": $NUMBERS_JSON,
    "allowed_addresses": [],
    "krisp_enabled": false
  }
}
JSON

# 2. Dispatch rule — when a call arrives on the trunk, create a room named
#    'dialog-call-<callId>' and dispatch our agent (the worker registered by
#    scripts/run-livekit-agent.sh) to it. Agent name is empty in our worker
#    registration so we omit it here too — LiveKit uses any available worker.
cat > "$DISPATCH_FILE" <<'JSON'
{
  "dispatch_rule": {
    "name": "Dialog inbound dispatch",
    "trunk_ids": [],
    "rule": {
      "dispatchRuleIndividual": {
        "roomPrefix": "dialog-call-"
      }
    }
  }
}
JSON

echo "════════════════════════════════════════════════════"
echo "1. Creating SIP inbound trunk..."
echo "════════════════════════════════════════════════════"
TRUNK_OUTPUT=$(lk sip inbound create "$TRUNK_FILE" 2>&1) || { echo "$TRUNK_OUTPUT"; exit 1; }
echo "$TRUNK_OUTPUT"
# Try to extract the trunk_id from output (lk prints SIPTrunkID:...)
TRUNK_ID=$(echo "$TRUNK_OUTPUT" | grep -oE 'ST_[A-Za-z0-9]+' | head -1)
if [ -z "$TRUNK_ID" ]; then
  echo "WARN: could not extract trunk ID; check 'lk sip inbound list'"
fi
echo "Trunk ID: $TRUNK_ID"

echo
echo "════════════════════════════════════════════════════"
echo "2. Creating dispatch rule (any-trunk routing for now)..."
echo "════════════════════════════════════════════════════"
# Inject the trunk ID into the dispatch rule so this rule is scoped to it
if [ -n "$TRUNK_ID" ]; then
  python3 -c "
import json
with open('$DISPATCH_FILE') as f: d = json.load(f)
d['dispatch_rule']['trunk_ids'] = ['$TRUNK_ID']
with open('$DISPATCH_FILE', 'w') as f: json.dump(d, f)
"
fi
DISPATCH_OUTPUT=$(lk sip dispatch create "$DISPATCH_FILE" 2>&1) || { echo "$DISPATCH_OUTPUT"; exit 1; }
echo "$DISPATCH_OUTPUT"

echo
echo "════════════════════════════════════════════════════"
echo "Done. SIP inbound is wired."
echo
echo "  LiveKit SIP URI: sip:z2s9j1lv8pp.sip.livekit.cloud"
echo
echo "Next: in Twilio Console → Phone Numbers → +12513335665 → Voice & Fax:"
echo "  - 'A CALL COMES IN' → set to: SIP"
echo "  - URL: sip:z2s9j1lv8pp.sip.livekit.cloud"
echo "  - Save"
echo
echo "Then make sure the agent is running (bash scripts/run-livekit-agent.sh)"
echo "and call +12513335665 to test."
echo "════════════════════════════════════════════════════"

rm -f "$TRUNK_FILE" "$DISPATCH_FILE"
