#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/3] Performance service and API tests"
if [[ -x "$ROOT_DIR/.venv/bin/pytest" ]]; then
  PYTEST=("$ROOT_DIR/.venv/bin/pytest")
else
  export UV_CACHE_DIR="${TMPDIR:-/tmp}/ncos-uv-cache"
  PYTEST=(uv run pytest)
fi
"${PYTEST[@]}" -q \
  tests/unit/test_performance.py \
  tests/unit/test_performance_review.py \
  tests/unit/test_composer.py \
  tests/integration/test_performance_api.py \
  tests/integration/test_performance_migration.py \
  tests/integration/test_today_work.py

echo "[2/3] Extension parser and UI tests in happy-dom"
pnpm --dir apps/extension exec vitest run \
  tests/performance-import.test.ts \
  tests/performance-workspace.test.tsx \
  tests/performance-import-panel.test.tsx \
  tests/simple-compose.test.tsx \
  tests/parsers.test.ts

echo "[3/3] Type contract check"
pnpm typecheck

echo "Performance verification without Chrome: PASS"
