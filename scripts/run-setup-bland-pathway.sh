#!/usr/bin/env bash
# run-setup-bland-pathway.sh — one-command wrapper for creating/updating the
# Dialog Bland Pathway. Sources .env, runs the Node script.
#
# Usage:  bash scripts/run-setup-bland-pathway.sh

set -e
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a; source .env; set +a
fi

if [ -z "$BLAND_API_KEY" ]; then
  echo "ERROR: BLAND_API_KEY not set in .env"
  exit 1
fi

exec node scripts/setup-bland-pathway.js
