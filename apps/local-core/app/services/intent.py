"""Intent board derived from one stored snapshot without provider calls."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy.orm import Session, sessionmaker

from app.models_db import Keyword, KeywordSnapshot
from app.services.published import build_content_state_index
from intelligence.keyword.intent import INTENT_VERSION, classify_intent
from intelligence.keyword.models import compact, trend_change


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _metric_view(metric: dict | None) -> dict | None:
    if not metric:
        return None
    pc = metric.get("monthly_pc_searches")
    mobile = metric.get("monthly_mobile_searches")
    masked = bool(metric.get("volume_masked", False))
    valid = isinstance(pc, int) and not isinstance(pc, bool) and isinstance(mobile, int) and not isinstance(mobile, bool)
    total = pc + mobile if valid and not masked else None
    return {
        "pc": pc if isinstance(pc, int) and not isinstance(pc, bool) else None,
        "mobile": mobile if isinstance(mobile, int) and not isinstance(mobile, bool) else None,
        "total": total,
        "masked": masked,
        "source": metric.get("source") or "SEARCH_AD",
        "collected_at": metric.get("collected_at"),
        "from_cache": bool(metric.get("from_cache", False)),
    }


def _trend_view(trend: dict | None) -> dict | None:
    if not trend:
        return None
    points = [
        row for row in trend.get("points", [])
        if isinstance(row, dict) and isinstance(row.get("ratio"), (int, float))
    ]
    if not points:
        return None
    ratios = [float(row["ratio"]) for row in points]
    return {
        "latest_period": points[-1].get("period"),
        "latest_ratio": ratios[-1],
        "relative_change": trend_change(ratios),
        "source": trend.get("source") or "NAVER_API_HUB",
        "collected_at": trend.get("collected_at"),
        "from_cache": bool(trend.get("from_cache", False)),
        "note": "요청 기간 안에서 독립 정규화된 상대 추세이며 절대 검색량이 아닙니다.",
    }


def _organic_view(landscape: dict | None) -> dict | None:
    if not landscape:
        return None
    return {
        "blog_total": landscape.get("blog_total"),
        "cafe_total": landscape.get("cafe_total"),
        "kin_total": landscape.get("kin_total"),
        "news_total": landscape.get("news_total"),
        "source": landscape.get("source") or "NAVER_API_HUB",
        "collected_at": landscape.get("collected_at"),
        "note": "검색 채널 문서 수 근거이며 광고 경쟁과 합산하지 않습니다.",
    }


def _missing_content_state() -> dict:
    return {
        "state": "missing",
        "draft_count": 0,
        "last_draft_at": None,
        "published_content_id": None,
        "published_url": None,
        "published_at": None,
    }


class IntentBoardService:
    def __init__(self, session_factory: sessionmaker[Session]):
        self._sessions = session_factory

    def get(self, snapshot_id: int) -> dict | None:
        with self._sessions() as session:
            snapshot = session.get(KeywordSnapshot, snapshot_id)
            if snapshot is None:
                return None
            keyword = session.get(Keyword, snapshot.keyword_id)
            if keyword is None:
                return None
            payload = snapshot.payload if isinstance(snapshot.payload, dict) else {}
            root_metric = payload.get("metric") if isinstance(payload.get("metric"), dict) else None
            related = payload.get("related_keywords") if isinstance(payload.get("related_keywords"), list) else []
            metrics = ([root_metric] if root_metric else [{"keyword": keyword.text}]) + [
                row for row in related if isinstance(row, dict)
            ]
            state_index = build_content_state_index(session)
            seen: set[str] = set()
            items: list[dict] = []
            for metric in metrics:
                text = str(metric.get("keyword") or keyword.text).strip()
                key = compact(text)
                if not key or key in seen:
                    continue
                seen.add(key)
                classification = classify_intent(text)
                is_root = key == compact(keyword.text)
                items.append(
                    {
                        "keyword": classification["normalized_keyword"],
                        "intent": classification["intent"],
                        "intent_version": classification["intent_version"],
                        "matched_markers": classification["matched_markers"],
                        "confidence": classification["confidence"],
                        "metric": _metric_view(metric),
                        "trend": _trend_view(payload.get("trend")) if is_root and isinstance(payload.get("trend"), dict) else None,
                        "organic": _organic_view(payload.get("landscape")) if is_root and isinstance(payload.get("landscape"), dict) else None,
                        "commercial": {
                            "ad_competition": metric.get("ad_competition"),
                            "source": metric.get("source") or "SEARCH_AD",
                            "note": "광고 경쟁 근거이며 Organic·Trend와 합산하지 않습니다.",
                        },
                        "content": state_index.get(key, _missing_content_state()),
                    }
                )
            return {
                "snapshot_id": snapshot.id,
                "keyword": keyword.text,
                "intent_version": INTENT_VERSION,
                "collected_at": _iso(snapshot.collected_at),
                "items": items,
            }
