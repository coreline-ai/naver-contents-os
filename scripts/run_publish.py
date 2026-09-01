"""Phase 6 E2E runner: plan item -> draft (LLM or skeleton) -> health gate -> SmartEditor 임시저장.

Prerequisites:
  1. Chrome running with --remote-debugging-port=9222 and logged into Naver
  2. (optional) Ollama running for real LLM drafting; use --no-llm for a skeleton draft

Usage:
  uv run python scripts/run_publish.py --keyword "애드포스트 승인" --order 2 \
      --blog-id <your_blog_id> --tags 애드포스트,블로그수익 [--no-llm]

This tool DRAFT-SAVES only. Publishing is a human decision (docs/01).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "local-core"))
sys.path.insert(0, str(ROOT / "python"))

from app import deps  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.services.drafts import DraftService, SqlJobStore  # noqa: E402
from providers.llm.ollama import OllamaProvider  # noqa: E402
from publisher.browser import attached_page  # noqa: E402
from publisher.editor import SmartEditorAdapter  # noqa: E402
from publisher.jobs import PublishJobRunner  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--order", type=int, default=1, help="15편 플랜에서 사용할 항목 순번")
    parser.add_argument("--blog-id", required=True)
    parser.add_argument("--tags", default="", help="쉼표 구분")
    parser.add_argument("--no-llm", action="store_true", help="LLM 없이 템플릿 스켈레톤으로 초안 생성")
    parser.add_argument("--cdp", default="http://127.0.0.1:9222")
    parser.add_argument("--dry-run", action="store_true", help="초안 생성까지만 (브라우저 미사용)")
    args = parser.parse_args()

    settings = get_settings()
    analysis = deps.get_analyze_service().analyze(args.keyword)
    plan_item = next((p for p in analysis["plan"] if p["order"] == args.order), None)
    if plan_item is None:
        print(f"플랜에 순번 {args.order} 항목이 없습니다 (1~{len(analysis['plan'])})")
        return 2
    print(f"플랜 항목: [{plan_item['blog_type']}] {plan_item['title']}")

    llm = None
    if not args.no_llm and settings.llm_provider == "local":
        llm = OllamaProvider(settings.ollama_base_url, settings.ollama_model)
    questions = [q["text"] for q in analysis.get("questions", []) if q["kind"] == "question"]

    drafts = DraftService(deps.get_session_factory(), llm)
    draft = drafts.create_draft(analysis["keyword"], plan_item, questions)
    print(f"초안 생성: draft_id={draft['draft_id']} v{draft['version']} 제목='{draft['title']}' "
          f"본문 {len(draft['body'])}자")

    if args.dry_run:
        print("dry-run: 브라우저 단계는 건너뜁니다.")
        return 0

    tags = [t for t in args.tags.split(",") if t.strip()]
    runner = PublishJobRunner(SqlJobStore(deps.get_session_factory()))
    with attached_page(args.cdp) as page:
        adapter = SmartEditorAdapter(page)
        result = runner.run(
            page,
            adapter,
            draft_id=draft["draft_id"],
            blog_id=args.blog_id,
            title=draft["title"],
            body=draft["body"],
            tags=tags,
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["status"] == "draft_saved":
        print("\n임시저장 완료. SmartEditor에서 내용을 검토한 뒤 발행 여부를 직접 결정하세요.")
        return 0
    print("\n자동화가 중단되었습니다. 위 단계와 오류를 확인하세요 (잘못된 게시 방지 게이트).")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
