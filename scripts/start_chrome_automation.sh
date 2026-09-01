#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${NCOS_CHROME_PROFILE:-$ROOT_DIR/data/chrome-automation-profile}"
PORT="${NCOS_CDP_PORT:-9222}"
CHROME_APP="${NCOS_CHROME_APP:-Google Chrome}"

mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

echo "Starting $CHROME_APP with the dedicated NCOS automation profile."
echo "Profile: $PROFILE_DIR"
echo "CDP: http://127.0.0.1:$PORT"
echo "Sign into Naver once in this separate window before running run_publish.py."

open -na "$CHROME_APP" --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check
