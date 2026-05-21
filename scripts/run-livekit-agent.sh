#!/usr/bin/env bash
# run-livekit-agent.sh — one-command dev runner for the LiveKit Riley agent.
#
# Creates a virtualenv (.venv inside scripts/livekit-agent), installs deps if
# missing or stale, sources .env, and runs the agent in dev mode.
#
# Usage:
#   bash scripts/run-livekit-agent.sh           # dev mode (browser playground)
#   bash scripts/run-livekit-agent.sh start     # production worker mode

set -e
cd "$(dirname "$0")/.."

# Source .env if present so agent.py picks up all secrets without us re-declaring
if [ -f .env ]; then
  set -a; source .env; set +a
fi

AGENT_DIR="scripts/livekit-agent"
VENV_DIR="$AGENT_DIR/.venv"
REQS="$AGENT_DIR/requirements.txt"

# Pick a Python 3.10+ interpreter. LiveKit Agents needs TypeAlias (added 3.10).
PY=""
for cand in python3.13 python3.12 python3.11 python3.10; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "ERROR: need python3.10 or newer. Install with:  brew install python@3.12"
  exit 1
fi
echo "Using $($PY --version) at $(command -v $PY)"

# Create venv on first run
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtualenv at $VENV_DIR (one-time setup)..."
  "$PY" -m venv "$VENV_DIR"
fi

# Activate
source "$VENV_DIR/bin/activate"

# Install deps if requirements.txt is newer than the marker file (or first run)
MARKER="$VENV_DIR/.installed-from"
if [ ! -f "$MARKER" ] || [ "$REQS" -nt "$MARKER" ]; then
  echo "Installing/updating dependencies from $REQS..."
  pip install --quiet --upgrade pip
  pip install --quiet -r "$REQS"
  cp "$REQS" "$MARKER"
  echo "Dependencies installed."
fi

# Mode: 'dev' (default) opens the LiveKit playground for browser testing
MODE="${1:-dev}"

echo
echo "════════════════════════════════════════════════════"
echo "Starting Riley LiveKit agent in '$MODE' mode"
echo "  - Mic/speakers: open the URL printed below in your browser"
echo "  - Tools call:   $SELF_BASE_URL (or default Railway URL)"
echo "  - Stop:         Ctrl-C"
echo "════════════════════════════════════════════════════"
echo
exec python "$AGENT_DIR/agent.py" "$MODE"
