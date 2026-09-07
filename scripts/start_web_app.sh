#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" != "--pair-only" ]]; then
  pnpm build:web
fi
exec uv run python scripts/start_web_app.py "$@"
