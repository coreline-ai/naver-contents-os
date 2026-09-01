#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

uv run pytest -q
pnpm typecheck
pnpm test:ext
pnpm build:ext
uv run python -m compileall -q apps/local-core python scripts tests alembic
uv run alembic current

if [[ "${1:-}" == "--live" ]]; then
  uv run pytest -q -m smoke tests/smoke
fi

echo "NCOS verification: PASS"
