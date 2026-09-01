"""Question/review candidate extraction from 지식iN·카페 search results (docs/13 Phase 2).

Real questions people ask become FAQ/HOWTO topics; cafe reviews become experience angles.
"""

from __future__ import annotations

from intelligence.keyword.models import clean_title, compact
from providers.models import SearchItem, SearchLandscape

QUESTION_MARKERS = ("?", "나요", "까요", "가요", "어떻게", "얼마", "언제", "왜 ", "방법", "조건", "될까", "인가요", "하나요")
REVIEW_MARKERS = ("후기", "리뷰", "경험", "해봤", "사용기", "됐어요", "됐습니다", "성공", "실패")


def _kind(title: str) -> str | None:
    if any(marker in title for marker in QUESTION_MARKERS):
        return "question"
    if any(marker in title for marker in REVIEW_MARKERS):
        return "review"
    return None


def extract_candidates(landscape: SearchLandscape | None, limit: int = 12) -> list[dict]:
    if landscape is None:
        return []
    sources: list[tuple[str, SearchItem]] = [("kin", i) for i in landscape.kin_items] + [
        ("cafe", i) for i in landscape.cafe_items
    ]
    seen: set[str] = set()
    out: list[dict] = []
    for channel, item in sources:
        title = clean_title(item.title)
        kind = _kind(title)
        if kind is None:
            continue
        key = compact(title)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append({"text": title, "kind": kind, "channel": channel})
        if len(out) >= limit:
            break
    return out
