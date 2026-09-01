"""15-piece content planner (docs/13 Phase 2).

Rule-based and deterministic for a given snapshot: every item names its target
keyword, blog type, angle, and a data-backed reason. LLM writing happens later
(Phase 6); planning itself needs no model call.
"""

from __future__ import annotations

from intelligence.keyword.models import compact
from planner.types import BlogType
from providers.models import KeywordMetric, SearchLandscape, TrendSeries

DEFAULT_PLAN_SIZE = 15

_TYPE_HINTS: tuple[tuple[str, BlogType], ...] = (
    ("비교", BlogType.COMPARISON),
    ("vs", BlogType.COMPARISON),
    ("후기", BlogType.REVIEW),
    ("리뷰", BlogType.REVIEW),
    ("추천", BlogType.PRODUCT),
    ("가격", BlogType.PRODUCT),
    ("방법", BlogType.HOWTO),
    ("하는법", BlogType.HOWTO),
    ("조건", BlogType.POLICY),
    ("기준", BlogType.POLICY),
    ("신청", BlogType.POLICY),
    ("승인", BlogType.POLICY),
)

_FILLER_ANGLES: tuple[tuple[str, BlogType], ...] = (
    ("자주 묻는 질문 FAQ 모음", BlogType.HOWTO),
    ("초보가 저지르는 실수 정리", BlogType.HOWTO),
    ("최신 변경사항 한눈에 정리", BlogType.NEWS),
    ("케이스별 체크리스트", BlogType.HOWTO),
    ("한 달 실전 기록", BlogType.REVIEW),
    ("숫자로 보는 현황 분석", BlogType.HOMEFEED),
    ("성공 사례 vs 실패 사례", BlogType.COMPARISON),
)


def infer_blog_type(keyword: str) -> BlogType:
    lowered = keyword.lower()
    for marker, blog_type in _TYPE_HINTS:
        if marker in lowered:
            return blog_type
    return BlogType.HOWTO


def _volume_reason(metric: KeywordMetric | None) -> str:
    if metric is None or metric.monthly_total_searches is None:
        return "검색량 데이터 없음"
    return f"월간 검색량 {metric.monthly_total_searches:,}"


def build_content_plan(
    keyword: str,
    metric: KeywordMetric | None,
    related: list[KeywordMetric],
    landscape: SearchLandscape | None,
    trend: TrendSeries | None,
    questions: list[dict],
    n: int = DEFAULT_PLAN_SIZE,
) -> list[dict]:
    items: list[dict] = []
    used_keys: set[str] = set()

    def add(title: str, blog_type: BlogType, target: str, angle: str, reason: str) -> None:
        key = compact(title)
        if key in used_keys or len(items) >= n:
            return
        used_keys.add(key)
        items.append(
            {
                "order": len(items) + 1,
                "title": title,
                "blog_type": blog_type.value,
                "target_keyword": target,
                "angle": angle,
                "reason": reason,
            }
        )

    # 1) pillar post for the main keyword
    pillar_reason = _volume_reason(metric)
    if landscape is not None and landscape.blog_total is not None:
        pillar_reason += f", 블로그 문서 {landscape.blog_total:,}건"
    add(
        f"{keyword} 총정리 가이드",
        BlogType.SERIES,
        keyword,
        "시리즈 허브(각 편으로 내부 링크)",
        pillar_reason,
    )

    # 2) real questions people ask (지식iN·카페)
    for q in questions[:6]:
        blog_type = BlogType.POLICY if q["kind"] == "question" else BlogType.REVIEW
        source = "지식iN 질문" if q["channel"] == "kin" else "카페 반응"
        add(q["text"], infer_blog_type(q["text"]) if q["kind"] == "question" else blog_type,
            keyword, "실제 질문에 답하는 글", f"{source}에서 수집된 실제 수요")

    # 3) high-volume related keywords
    ranked = sorted(
        (m for m in related if m.keyword and compact(m.keyword) != compact(keyword)),
        key=lambda m: (-(m.monthly_total_searches or 0), m.keyword),
    )
    for m in ranked[:8]:
        add(
            f"{m.keyword} 완벽 정리",
            infer_blog_type(m.keyword),
            m.keyword,
            "연관 검색어 공략",
            f"연관 키워드, {_volume_reason(m)}, 광고 경쟁 {m.ad_competition or '미상'}",
        )

    # 4) trend/news angle when the landscape says something is happening
    if landscape is not None and landscape.news_items:
        add(f"{keyword} 최근 이슈와 영향 정리", BlogType.NEWS, keyword,
            "뉴스 연계 홈피드형", f"뉴스 문서 {landscape.news_total or 0:,}건 감지")

    # 5) deterministic fillers until n
    index = 0
    while len(items) < n and index < len(_FILLER_ANGLES) * 2:
        angle, blog_type = _FILLER_ANGLES[index % len(_FILLER_ANGLES)]
        suffix = "" if index < len(_FILLER_ANGLES) else f" #{index // len(_FILLER_ANGLES) + 1}"
        add(f"{keyword} {angle}{suffix}", blog_type, keyword, angle, "시리즈 커버리지 확장")
        index += 1

    # series prev/next links
    for i, item in enumerate(items):
        item["series_prev"] = items[i - 1]["order"] if i > 0 else None
        item["series_next"] = items[i + 1]["order"] if i < len(items) - 1 else None
    return items
