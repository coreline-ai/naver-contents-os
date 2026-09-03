"""Deterministic Korean search-intent classification (intent-v1)."""

from __future__ import annotations

from intelligence.keyword.models import compact, normalize_keyword

INTENT_VERSION = "intent-v1"

# Priority is part of the versioned contract. Keep high-risk/help-seeking intent first.
INTENT_MARKERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("troubleshooting", ("오류", "안됨", "실패", "보류", "해결", "문제", "반려")),
    ("eligibility", ("신청", "승인", "자격", "조건", "대상", "기준")),
    ("comparison_review", ("비교", "후기", "리뷰", "장단점", "vs", "추천", "경험")),
    ("commercial", ("가격", "비용", "구매", "할인", "최저가", "수익", "광고", "입찰")),
    ("local_visit", ("맛집", "카페", "병원", "위치", "근처", "방문", "주차", "예약", "지역")),
    ("howto", ("방법", "하는법", "사용법", "설정", "만들기", "절차")),
    ("informational", ("뜻", "정보", "정리", "가이드", "무엇", "왜", "종류")),
)


def classify_intent(keyword: str) -> dict:
    normalized = normalize_keyword(keyword)
    normalized_compact = compact(normalized)
    if not normalized_compact:
        return {
            "intent": "other",
            "intent_version": INTENT_VERSION,
            "matched_markers": [],
            "confidence": "low",
            "normalized_keyword": normalized,
        }
    for intent, markers in INTENT_MARKERS:
        matched = [marker for marker in markers if compact(marker) in normalized_compact]
        if matched:
            return {
                "intent": intent,
                "intent_version": INTENT_VERSION,
                "matched_markers": matched,
                "confidence": "high" if len(matched) >= 2 else "medium",
                "normalized_keyword": normalized,
            }
    return {
        "intent": "other",
        "intent_version": INTENT_VERSION,
        "matched_markers": [],
        "confidence": "low",
        "normalized_keyword": normalized,
    }
