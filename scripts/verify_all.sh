#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/check_no_tracked_runtime.sh

uv run pytest -q
pnpm typecheck
pnpm test:ext
pnpm build:ext
uv run python -m compileall -q apps/local-core python scripts tests alembic

VERIFY_DB="$(mktemp "${TMPDIR:-/tmp}/ncos-verify.XXXXXX")"
cleanup() {
  rm -f -- "$VERIFY_DB" "$VERIFY_DB-journal" "$VERIFY_DB-shm" "$VERIFY_DB-wal"
}
trap cleanup EXIT
DB_PATH="$VERIFY_DB" uv run alembic upgrade head
DB_PATH="$VERIFY_DB" uv run alembic current

if [[ "${1:-}" == "--live" ]]; then
  uv run pytest -q -m smoke tests/smoke
fi

echo "NCOS verification: PASS"
