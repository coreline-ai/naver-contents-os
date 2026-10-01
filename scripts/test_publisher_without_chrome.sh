#!/usr/bin/env bash
# Account-free regressions, not a live NAVER end-to-end success certificate.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "격리 Publisher 검증: 임시 DB·가짜 Chrome/debugger·mock UI 사용"
echo "운영 DB·네이버 계정·외부 AI/API를 실행하지 않습니다."
bash scripts/check_no_tracked_runtime.sh
uv run pytest -q tests/unit/test_publish_integrity.py tests/integration/test_verified_publish_contract.py
pnpm --filter extension exec vitest run tests/background-publisher.test.ts tests/debugger-editor.test.ts tests/blog-publisher-route.test.ts tests/smarteditor.test.ts
pnpm --filter web exec vitest run tests/writer.test.tsx tests/workflow.test.tsx
echo "Publisher 격리 회귀: PASS. 실제 네이버 임시저장 인수는 별도입니다."
