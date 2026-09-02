"""Pure calculations for seed-based rising keyword discovery.

Search Trend and Shopping Insight ratios are relative indexes.  The functions in
this module only compare two windows inside one series and never treat a ratio as
absolute search volume.
"""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable, Mapping
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
SCORE_VERSION = "freshness-v1"
MODE_WEIGHTS = {
    "general": (0.65, 0.35),
    "local": (0.65, 0.35),
    "shopping": (0.70, 0.30),
    "news": (0.35, 0.65),
}


def comparison_window(today: date | datetime | None = None) -> dict[str, date]:
    if today is None:
        base = datetime.now(KST).date()
    elif isinstance(today, datetime):
        base = today.astimezone(KST).date() if today.tzinfo else today.date()
    else:
        base = today
    end_date = base - timedelta(days=1)
    recent_start = end_date - timedelta(days=6)
    start_date = end_date - timedelta(days=13)
    return {
        "start_date": start_date,
        "recent_start": recent_start,
        "end_date": end_date,
    }


def _point_value(point) -> tuple[date, float] | None:
    period = point.get("period") if isinstance(point, Mapping) else getattr(point, "period", "")
    ratio = point.get("ratio") if isinstance(point, Mapping) else getattr(point, "ratio", None)
    try:
        parsed_date = date.fromisoformat(str(period)[:10])
        parsed_ratio = float(ratio)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed_ratio) or parsed_ratio < 0:
        return None
    return parsed_date, parsed_ratio


def summarize_trend(points: Iterable, *, today: date | datetime | None = None) -> dict:
    window = comparison_window(today)
    by_date: dict[date, float] = {}
    for point in points:
        parsed = _point_value(point)
        if parsed and window["start_date"] <= parsed[0] <= window["end_date"]:
            by_date[parsed[0]] = parsed[1]

    previous = [
        value for period, value in by_date.items()
        if window["start_date"] <= period < window["recent_start"]
    ]
    recent = [
        value for period, value in by_date.items()
        if window["recent_start"] <= period <= window["end_date"]
    ]
    coverage = {
        "observed_days": len(previous) + len(recent),
        "recent_days": len(recent),
        "previous_days": len(previous),
    }
    comparable = len(previous) >= 6 and len(recent) >= 6 and coverage["observed_days"] >= 12
    base = {
        "recent7_avg": round(sum(recent) / len(recent), 4) if recent else None,
        "previous7_avg": round(sum(previous) / len(previous), 4) if previous else None,
        "growth_rate": None,
        "direction": "insufficient",
        "trend_score": None,
        "coverage": coverage,
        "comparison_window": {key: value.isoformat() for key, value in window.items()},
    }
    if not comparable:
        return base

    recent_avg = float(base["recent7_avg"])
    previous_avg = float(base["previous7_avg"])
    if previous_avg == 0:
        if recent_avg > 0:
            base["direction"] = "new"
            base["trend_score"] = round(
                min(100.0, max(0.0, recent_avg)) * (len(recent) / 7), 2
            )
        else:
            base.update(growth_rate=0.0, direction="steady", trend_score=0.0)
        return base

    growth = round((recent_avg - previous_avg) / previous_avg * 100, 2)
    direction = "rising" if growth >= 10 else "falling" if growth <= -10 else "steady"
    base.update(
        growth_rate=growth,
        direction=direction,
        trend_score=round(min(100.0, max(0.0, growth) / 2), 2),
    )
    return base


def _published_at(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, OverflowError):
        try:
            if len(text) == 8 and text.isdigit():
                parsed = datetime.strptime(text, "%Y%m%d").replace(tzinfo=KST)
            else:
                parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=KST)
    return parsed.astimezone(KST)


def _article_key(item: Mapping) -> str:
    raw = str(item.get("original_link") or item.get("originallink") or item.get("link") or "")
    if raw:
        try:
            parts = urlsplit(raw)
            return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"), "", ""))
        except ValueError:
            pass
    return str(item.get("title") or "").strip().casefold()


def summarize_news(
    items: Iterable[Mapping],
    *,
    today: date | datetime | None = None,
    sample_limit: int = 100,
) -> dict:
    window = comparison_window(today)
    start = datetime.combine(window["recent_start"], time.min, tzinfo=KST)
    end = datetime.combine(window["end_date"], time.max, tzinfo=KST)
    raw_items = list(items)
    unique: dict[str, datetime] = {}
    valid_dates: list[datetime] = []
    for item in raw_items:
        published = _published_at(item.get("published_at") or item.get("pubDate") or item.get("posted_at"))
        if published is None or published > end:
            continue
        valid_dates.append(published)
        if published < start:
            continue
        key = _article_key(item)
        if not key:
            continue
        current = unique.get(key)
        if current is None or published > current:
            unique[key] = published

    count = len(unique)
    latest = max(unique.values()) if unique else None
    volume_score = round(100 * math.log1p(count) / math.log(101), 2)
    if latest is None:
        recency_score = 0.0
    else:
        age_hours = max(0.0, (end - latest).total_seconds() / 3600)
        recency_score = round(max(0.0, 100 * (1 - age_hours / 168)), 2)
    news_score = round(volume_score * 0.7 + recency_score * 0.3, 2)
    sample_capped = (
        len(raw_items) >= sample_limit
        and len(valid_dates) == len(raw_items)
        and all(value >= start for value in valid_dates)
    )
    return {
        "news_7d_sample_count": count,
        "sample_capped": sample_capped,
        "latest_news_at": latest.isoformat() if latest else None,
        "news_volume_score": volume_score,
        "news_recency_score": recency_score,
        "news_score": news_score,
    }


def combine_freshness(
    trend: Mapping,
    news: Mapping | None,
    *,
    mode: str,
    volume_masked: bool,
) -> dict:
    trend_weight, news_weight = MODE_WEIGHTS.get(mode, MODE_WEIGHTS["general"])
    trend_score = trend.get("trend_score")
    news_score = news.get("news_score") if news else None
    reason = None
    if trend.get("direction") == "insufficient" or trend_score is None:
        reason = "insufficient_trend"
    elif news is None or news_score is None:
        reason = "news_unavailable"

    freshness_score = None
    if reason is None:
        freshness_score = round(float(trend_score) * trend_weight + float(news_score) * news_weight, 2)

    coverage = trend.get("coverage", {})
    observed = int(coverage.get("observed_days", 0))
    if freshness_score is None:
        confidence = "unavailable"
    elif trend.get("direction") == "new" or volume_masked:
        confidence = "low"
    elif observed == 14 and not news.get("sample_capped", False):
        confidence = "high"
    else:
        confidence = "medium"

    return {
        "freshness_score": freshness_score,
        "confidence": confidence,
        "components": {
            "trend_score": trend_score,
            "news_volume_score": news.get("news_volume_score") if news else None,
            "news_recency_score": news.get("news_recency_score") if news else None,
            "news_score": news_score,
            "trend_weight": trend_weight,
            "news_weight": news_weight,
            "reason": reason,
        },
    }
