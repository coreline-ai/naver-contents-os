"""Local-only performance imports and explainable content improvement suggestions.

The service accepts normalized aggregate rows only. It deliberately has no Naver
login, cookie, private endpoint, or background-scraping code.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import re
from statistics import median
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy import and_, delete, func, or_, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import (
    CommerceAttributionSnapshot,
    ContentPerformanceSnapshot,
    Draft,
    Keyword,
    KeywordSnapshot,
    OwnedChannel,
    PerformanceImportRun,
    PerformanceRecommendation,
    PerformanceTrackingLink,
    PublishedContent,
    QueryPerformanceSnapshot,
    SerpSnapshot,
    SitePerformanceSnapshot,
)
from app.services.published import normalize_public_url, publication_state
from intelligence.keyword.models import normalize_keyword


SOURCES = frozenset({"creator_advisor", "biz_advisor", "search_advisor"})
DATA_KINDS = frozenset(
    {"content_performance", "query_performance", "commerce_attribution", "site_performance"}
)
DATA_STATES = frozenset({"pending", "partial", "observed_zero", "unavailable", "ready"})
GRAINS = frozenset({"daily", "weekly", "monthly"})
CALCULATION_VERSION = "performance-v2"
ROW_CAP = 1000

SOURCE_KINDS = {
    "creator_advisor": frozenset({"content_performance", "query_performance"}),
    "biz_advisor": frozenset({"commerce_attribution"}),
    "search_advisor": frozenset({"site_performance"}),
}
CHANNEL_KINDS = {
    "creator_advisor": "blog",
    "biz_advisor": "smartstore",
    "search_advisor": "website",
}

METRIC_DICTIONARY: dict[str, dict[str, Any]] = {
    "content_performance": {
        "source": "creator_advisor",
        "required_any": ["canonical_url", "published_content_id", "title"],
        "metrics": {
            "views": {"unit": "count", "nullable": True},
            "impressions": {"unit": "count", "nullable": True},
            "inflows": {"unit": "count", "nullable": True},
            "ctr": {"unit": "percent_0_100", "nullable": True},
            "average_rank": {"unit": "rank", "nullable": True},
            "likes": {"unit": "count", "nullable": True},
            "comments": {"unit": "count", "nullable": True},
        },
        "delay_note": "Creator Advisor 화면의 반영 주기를 따르며 반영 전 0은 pending으로 표시하세요.",
    },
    "query_performance": {
        "source": "creator_advisor",
        "required": ["query"],
        "metrics": {
            "impressions": {"unit": "count", "nullable": True},
            "inflows": {"unit": "count", "nullable": True},
            "ctr": {"unit": "percent_0_100", "nullable": True},
            "average_rank": {"unit": "rank", "nullable": True},
        },
        "delay_note": "Creator Advisor 검색 노출 분석의 집계 시각을 그대로 기록하세요.",
    },
    "commerce_attribution": {
        "source": "biz_advisor",
        "required": ["tracking_id"],
        "metrics": {
            "inflows": {"unit": "count", "nullable": True},
            "product_views": {"unit": "count", "nullable": True},
            "orders": {"unit": "count", "nullable": True},
            "conversion_rate": {"unit": "percent_0_100", "nullable": True},
            "attributed_revenue": {"unit": "krw", "nullable": True},
        },
        "delay_note": "유입 시각과 결제 시각의 집계 기준이 다를 수 있으며 직접 인과 매출로 해석하지 않습니다.",
    },
    "site_performance": {
        "source": "search_advisor",
        "required": ["page_url"],
        "metrics": {
            "collected_pages": {"unit": "count", "nullable": True},
            "indexed_pages": {"unit": "count", "nullable": True},
            "impressions": {"unit": "count", "nullable": True},
            "clicks": {"unit": "count", "nullable": True},
            "ctr": {"unit": "percent_0_100", "nullable": True},
        },
        "delay_note": "웹 검색 성과는 최근 90일 범위이며 공식 안내상 약 1주 지연됩니다.",
    },
}

_METRIC_FIELDS = {
    kind: tuple(definition["metrics"].keys()) for kind, definition in METRIC_DICTIONARY.items()
}
_ASCII_TRACKING = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_UNICODE_TRACKING = re.compile(r"^[A-Za-z0-9가-힣._-]{1,100}$")
_SMARTSTORE_HOSTS = frozenset(
    {"smartstore.naver.com", "m.smartstore.naver.com", "brand.naver.com", "m.brand.naver.com"}
)
_NAVER_HOSTED = frozenset(
    {
        "blog.naver.com",
        "m.blog.naver.com",
        "smartstore.naver.com",
        "m.smartstore.naver.com",
        "brand.naver.com",
        "m.brand.naver.com",
    }
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _hash_payload(value: object) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _validate_http_url(value: str, *, field: str) -> str:
    try:
        parsed = urlsplit(value.strip())
    except ValueError as exc:
        raise ValueError(f"{field} is invalid") from exc
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{field} must use http or https")
    if parsed.username or parsed.password:
        raise ValueError(f"{field} must not contain credentials")
    return value.strip()


def _hostname(value: str) -> str:
    return (urlsplit(value).hostname or "").casefold()


def _number(value: object, *, field: str, integer: bool = False) -> int | float | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise ValueError(f"{field} must be numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be numeric") from exc
    if not math.isfinite(result):
        raise ValueError(f"{field} must be finite")
    if result < 0:
        raise ValueError(f"{field} must not be negative")
    if field in {"ctr", "conversion_rate"} and result > 100:
        raise ValueError(f"{field} must be between 0 and 100")
    if integer:
        if not result.is_integer():
            raise ValueError(f"{field} must be a whole number")
        return int(result)
    return round(result, 4)


def _derived_state(row: dict, fields: tuple[str, ...], explicit: object) -> str:
    if explicit not in {None, ""}:
        state = str(explicit)
        if state not in DATA_STATES:
            raise ValueError("data_state is invalid")
        return state
    values = [row.get(field) for field in fields]
    available = [value for value in values if value is not None]
    if not available:
        return "unavailable"
    if len(available) < len(values):
        return "partial"
    if all(float(value) == 0 for value in available):
        return "observed_zero"
    return "ready"


def _weighted_ctr(impressions: int | None, clicks: int | None) -> float | None:
    if impressions is None or clicks is None or impressions <= 0:
        return None
    return round(clicks / impressions * 100, 4)


def _same_content_target(row: ContentPerformanceSnapshot):
    if row.canonical_url:
        return ContentPerformanceSnapshot.canonical_url == row.canonical_url
    if row.published_content_id is not None:
        return ContentPerformanceSnapshot.published_content_id == row.published_content_id
    return and_(ContentPerformanceSnapshot.canonical_url.is_(None),
                ContentPerformanceSnapshot.published_content_id.is_(None),
                ContentPerformanceSnapshot.title == row.title)


def _content_target(url, publication_id, title) -> str:
    return url or (f"publication:{publication_id}" if publication_id is not None else f"title:{title}")


def _previous_period(model, row):
    """Compare only adjacent, equal-duration windows at the same granularity."""
    length = row.period_end - row.period_start + timedelta(days=1)
    return and_(model.grain == row.grain,
                model.period_start == row.period_start - length,
                model.period_end == row.period_start - timedelta(days=1))


def _same_query_target(row):
    return and_(QueryPerformanceSnapshot.query == row.query,
                QueryPerformanceSnapshot.canonical_url == row.canonical_url,
                QueryPerformanceSnapshot.published_content_id == row.published_content_id)


def _recent_period(end: date, now: datetime | None = None) -> bool:
    today = (now or _utcnow()).astimezone(timezone(timedelta(hours=9))).date()
    return 0 <= (today - end).days <= 90


def _has_followup_content(session: Session, row: QueryPerformanceSnapshot) -> bool:
    """An existing non-archived followup is a reason to resume, not generate again."""
    original = session.get(PublishedContent, row.published_content_id) if row.published_content_id else None
    drafts = select(Draft.id).join(Keyword, Keyword.id == Draft.keyword_id).where(
        Keyword.text == row.query, Draft.user_status != "archived",
    )
    publications = select(PublishedContent.id).join(Keyword, Keyword.id == PublishedContent.keyword_id).where(
        Keyword.text == row.query, PublishedContent.archived_at.is_(None),
    )
    if original:
        publications = publications.where(PublishedContent.id != original.id)
        if original.draft_id:
            drafts = drafts.where(Draft.id != original.draft_id)
    return session.scalar(drafts.limit(1)) is not None or session.scalar(publications.limit(1)) is not None


def actionable_recommendation(session: Session, recommendation, *, now=None) -> bool:
    """Shared read-only guard for the dashboard and Today Work; history is retained."""
    if recommendation.calculation_version != CALCULATION_VERSION or not _recent_period(recommendation.period_end, now):
        return False
    publication = session.get(PublishedContent, recommendation.published_content_id) if recommendation.published_content_id else None
    if publication and publication.archived_at is not None:
        return False
    model = {"content_performance": ContentPerformanceSnapshot,
             "query_performance": QueryPerformanceSnapshot}.get(recommendation.source_snapshot_type)
    if model is None:
        return False
    row = session.get(model, recommendation.source_snapshot_id)
    if row is None or row.channel_id != recommendation.channel_id or row.data_state not in {"ready", "partial"}:
        return False
    if row.published_content_id != recommendation.published_content_id:
        return False
    if model is QueryPerformanceSnapshot and _has_followup_content(session, row):
        return False
    target = _same_content_target(row) if model is ContentPerformanceSnapshot else _same_query_target(row)
    newer = session.scalar(select(model.id).where(
        model.channel_id == row.channel_id, target,
        or_(model.period_end > row.period_end, and_(model.period_end == row.period_end, model.id > row.id)),
    ).limit(1))
    return newer is None


class PerformanceService:
    def __init__(self, session_factory: sessionmaker[Session]):
        self._sessions = session_factory

    def metric_dictionary(self) -> dict:
        return {
            "version": "performance-import-v1",
            "row_cap": ROW_CAP,
            "data_states": sorted(DATA_STATES),
            "grains": sorted(GRAINS),
            "kinds": METRIC_DICTIONARY,
        }

    def create_channel(
        self,
        *,
        source: str,
        display_name: str,
        site_url: str | None = None,
        ownership_confirmed: bool = False,
    ) -> dict:
        source = source.strip()
        display_name = display_name.strip()
        if source not in SOURCES:
            raise ValueError("source is invalid")
        if not display_name:
            raise ValueError("display_name is required")
        normalized_site: str | None = None
        if source == "search_advisor":
            if not ownership_confirmed:
                raise ValueError("you must confirm that you own the Search Advisor website")
            if not site_url:
                raise ValueError("site_url is required for Search Advisor")
            normalized_site = normalize_public_url(_validate_http_url(site_url, field="site_url"))
            if _hostname(normalized_site) in _NAVER_HOSTED:
                raise ValueError("Search Advisor channel must be an independently owned website")
        elif site_url:
            normalized_site = normalize_public_url(_validate_http_url(site_url, field="site_url"))

        with self._sessions() as session:
            existing = session.scalar(
                select(OwnedChannel).where(
                    OwnedChannel.source == source,
                    OwnedChannel.display_name == display_name,
                )
            )
            if existing is not None:
                if normalized_site and existing.site_url != normalized_site:
                    existing.site_url = normalized_site
                if source == "search_advisor":
                    existing.ownership_confirmed = True
                existing.enabled = True
                session.commit()
                return self._channel_view(existing)
            row = OwnedChannel(
                source=source,
                channel_kind=CHANNEL_KINDS[source],
                display_name=display_name,
                site_url=normalized_site,
                ownership_confirmed=source == "search_advisor" and ownership_confirmed,
                enabled=True,
            )
            session.add(row)
            session.commit()
            return self._channel_view(row)

    def list_channels(self, *, include_disabled: bool = True) -> dict:
        statement = select(OwnedChannel)
        if not include_disabled:
            statement = statement.where(OwnedChannel.enabled.is_(True))
        statement = statement.order_by(OwnedChannel.created_at, OwnedChannel.id)
        with self._sessions() as session:
            rows = session.scalars(statement).all()
            return {
                "items": [self._channel_view(row) for row in rows],
                "features": {
                    "creator": any(row.enabled and row.source == "creator_advisor" for row in rows),
                    "commerce": any(row.enabled and row.source == "biz_advisor" for row in rows),
                    "website": any(row.enabled and row.source == "search_advisor" for row in rows),
                },
            }

    def update_channel(self, channel_id: int, *, enabled: bool) -> dict | None:
        with self._sessions() as session:
            row = session.get(OwnedChannel, channel_id)
            if row is None:
                return None
            row.enabled = enabled
            session.commit()
            return self._channel_view(row)

    @staticmethod
    def _channel_view(row: OwnedChannel) -> dict:
        return {
            "id": row.id,
            "source": row.source,
            "channel_kind": row.channel_kind,
            "display_name": row.display_name,
            "site_url": row.site_url,
            "ownership_confirmed": row.ownership_confirmed,
            "enabled": row.enabled,
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }

    def preview_import(
        self,
        *,
        channel_id: int,
        source: str,
        data_kind: str,
        period_start: date,
        period_end: date,
        grain: str,
        rows: list[dict],
    ) -> dict:
        channel = self._validate_import_header(
            channel_id=channel_id,
            source=source,
            data_kind=data_kind,
            period_start=period_start,
            period_end=period_end,
            grain=grain,
            row_count=len(rows),
        )
        normalized: list[dict] = []
        warnings: list[str] = []
        seen_targets: set[str] = set()
        with self._sessions() as session:
            for index, row in enumerate(rows, start=1):
                clean, row_warnings = self._normalize_row(
                    session,
                    channel=channel,
                    data_kind=data_kind,
                    period_start=period_start,
            period_end=period_end,
                    grain=grain,
                    row=row,
                    row_number=index,
                )
                if clean["dedupe_key"] in seen_targets:
                    raise ValueError(f"row {index}: duplicate target in the same import")
                seen_targets.add(clean["dedupe_key"])
                normalized.append(clean)
                warnings.extend(row_warnings)
        payload = self._canonical_import_payload(
            channel_id=channel_id,
            source=source,
            data_kind=data_kind,
            period_start=period_start,
            period_end=period_end,
            grain=grain,
            rows=normalized,
        )
        return {
            "valid": True,
            "channel": self._channel_view(channel),
            "source": source,
            "data_kind": data_kind,
            "period": {"start": period_start.isoformat(), "end": period_end.isoformat()},
            "grain": grain,
            "row_count": len(normalized),
            "warnings": warnings,
            "input_hash": _hash_payload(payload),
            "rows": normalized,
        }

    def _canonical_import_payload(
        self,
        *,
        channel_id: int,
        source: str,
        data_kind: str,
        period_start: date,
        period_end: date,
        grain: str,
        rows: list[dict],
    ) -> dict:
        return {
            "channel_id": channel_id,
            "source": source,
            "data_kind": data_kind,
            "period_start": period_start.isoformat(),
            "period_end": period_end.isoformat(),
            "grain": grain,
            "rows": rows,
        }

    def _validate_import_header(
        self,
        *,
        channel_id: int,
        source: str,
        data_kind: str,
        period_start: date,
        period_end: date,
        grain: str,
        row_count: int,
    ) -> OwnedChannel:
        if source not in SOURCES:
            raise ValueError("source is invalid")
        if data_kind not in DATA_KINDS or data_kind not in SOURCE_KINDS[source]:
            raise ValueError("data_kind does not belong to source")
        if grain not in GRAINS:
            raise ValueError("grain is invalid")
        if period_start > period_end:
            raise ValueError("period_start must not be after period_end")
        if source == "search_advisor" and (period_end - period_start).days > 89:
            raise ValueError("Search Advisor imports must cover 90 days or fewer")
        if row_count < 1 or row_count > ROW_CAP:
            raise ValueError(f"rows must contain between 1 and {ROW_CAP} items")
        with self._sessions() as session:
            channel = session.get(OwnedChannel, channel_id)
            if channel is None:
                raise ValueError("channel not found")
            session.expunge(channel)
        if channel.source != source:
            raise ValueError("channel source does not match import source")
        if not channel.enabled:
            raise ValueError("channel is disabled")
        return channel

    def _normalize_row(
        self,
        session: Session,
        *,
        channel: OwnedChannel,
        data_kind: str,
        period_start: date,
        period_end: date,
        grain: str,
        row: dict,
        row_number: int,
    ) -> tuple[dict, list[str]]:
        clean: dict[str, Any] = {}
        warnings: list[str] = []
        integer_fields = {
            "views",
            "impressions",
            "inflows",
            "likes",
            "comments",
            "product_views",
            "orders",
            "collected_pages",
            "indexed_pages",
            "clicks",
        }
        for field in _METRIC_FIELDS[data_kind]:
            clean[field] = _number(row.get(field), field=field, integer=field in integer_fields)

        published_content_id = row.get("published_content_id")
        if data_kind == "site_performance" and published_content_id is not None:
            raise ValueError(f"row {row_number}: site performance cannot map to blog content")
        if published_content_id is not None:
            try:
                published_content_id = int(published_content_id)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"row {row_number}: published_content_id must be an integer") from exc
            if published_content_id < 1 or session.get(PublishedContent, published_content_id) is None:
                raise ValueError(f"row {row_number}: published_content_id not found")
        if data_kind != "site_performance":
            clean["published_content_id"] = published_content_id

        if data_kind in {"content_performance", "query_performance"}:
            canonical = str(row.get("canonical_url") or "").strip()
            clean["canonical_url"] = (
                normalize_public_url(_validate_http_url(canonical, field=f"row {row_number} canonical_url"))
                if canonical
                else None
            )
            if clean["canonical_url"] and published_content_id is not None:
                linked = session.get(PublishedContent, published_content_id)
                if normalize_public_url(linked.canonical_url) != clean["canonical_url"]:
                    raise ValueError(f"row {row_number}: canonical_url conflicts with published_content_id")
            if clean["canonical_url"]:
                publication = session.scalar(
                    select(PublishedContent).where(
                        PublishedContent.canonical_url == clean["canonical_url"]
                    )
                )
                if publication is not None:
                    if published_content_id and published_content_id != publication.id:
                        raise ValueError(f"row {row_number}: canonical_url conflicts with published_content_id")
                    clean["published_content_id"] = publication.id

        if data_kind == "content_performance":
            clean["title"] = str(row.get("title") or "").strip()[:200]
            if not (clean["canonical_url"] or clean["published_content_id"] or clean["title"]):
                raise ValueError(f"row {row_number}: canonical_url, published_content_id, or title is required")
            target = _content_target(clean["canonical_url"], clean["published_content_id"], clean["title"])
            ctr = _weighted_ctr(clean["impressions"], clean["inflows"])
            if ctr is not None:
                if clean["ctr"] is not None and abs(float(clean["ctr"]) - ctr) > 0.1:
                    warnings.append(f"{row_number}행 CTR을 노출·유입 기준으로 다시 계산했습니다.")
                clean["ctr"] = ctr
        elif data_kind == "query_performance":
            clean["query"] = normalize_keyword(str(row.get("query") or ""))
            if not clean["query"]:
                raise ValueError(f"row {row_number}: query is required")
            target = f"{clean['query']}|{clean['canonical_url'] or clean['published_content_id'] or ''}"
            ctr = _weighted_ctr(clean["impressions"], clean["inflows"])
            if ctr is not None:
                if clean["ctr"] is not None and abs(float(clean["ctr"]) - ctr) > 0.1:
                    warnings.append(f"{row_number}행 CTR을 노출·유입 기준으로 다시 계산했습니다.")
                clean["ctr"] = ctr
        elif data_kind == "commerce_attribution":
            clean["tracking_id"] = str(row.get("tracking_id") or "").strip()
            if not clean["tracking_id"] or len(clean["tracking_id"]) > 100:
                raise ValueError(f"row {row_number}: tracking_id is required and must be 100 characters or fewer")
            tracking_link = session.scalar(
                select(PerformanceTrackingLink).where(
                    PerformanceTrackingLink.tracking_id == clean["tracking_id"]
                )
            )
            if tracking_link is not None:
                if (clean["published_content_id"] is not None and tracking_link.published_content_id is not None
                        and clean["published_content_id"] != tracking_link.published_content_id):
                    raise ValueError(f"row {row_number}: tracking_id conflicts with published_content_id")
                clean["published_content_id"] = clean["published_content_id"] or tracking_link.published_content_id
            destination = str(row.get("destination_url") or "").strip()
            clean["destination_url"] = (
                self._validate_smartstore_url(destination) if destination else None
            )
            target = clean["tracking_id"]
            conversion = _weighted_ctr(clean["inflows"], clean["orders"])
            if conversion is not None:
                if clean["conversion_rate"] is not None and abs(float(clean["conversion_rate"]) - conversion) > 0.1:
                    warnings.append(f"{row_number}행 결제율을 유입·결제건 기준으로 다시 계산했습니다.")
                clean["conversion_rate"] = conversion
        else:
            page_url = str(row.get("page_url") or "").strip()
            clean["page_url"] = normalize_public_url(
                _validate_http_url(page_url, field=f"row {row_number} page_url")
            )
            if channel.site_url and _hostname(clean["page_url"]) != _hostname(channel.site_url):
                raise ValueError(f"row {row_number}: page_url must belong to the configured website")
            if _hostname(clean["page_url"]) in _NAVER_HOSTED:
                raise ValueError(f"row {row_number}: Search Advisor data cannot target Naver Blog or SmartStore")
            target = clean["page_url"]
            ctr = _weighted_ctr(clean["impressions"], clean["clicks"])
            if ctr is not None:
                if clean["ctr"] is not None and abs(float(clean["ctr"]) - ctr) > 0.1:
                    warnings.append(f"{row_number}행 CTR을 노출·클릭 기준으로 다시 계산했습니다.")
                clean["ctr"] = ctr

        clean["data_state"] = _derived_state(
            clean, _METRIC_FIELDS[data_kind], row.get("data_state")
        )
        clean["dedupe_key"] = _hash_payload(
            {
                "channel_id": channel.id,
                "kind": data_kind,
                "period_start": period_start.isoformat(),
                "period_end": period_end.isoformat(),
                "grain": grain,
                "target": target,
            }
        )
        return clean, warnings

    def create_import(self, **kwargs) -> dict:
        preview = self.preview_import(**kwargs)
        existing_view: dict | None = None
        with self._sessions() as session:
            existing = session.scalar(
                select(PerformanceImportRun).where(
                    PerformanceImportRun.input_hash == preview["input_hash"]
                )
            )
            if existing is not None:
                self._refresh_import_recommendations(session, existing)
                session.commit()
                existing_view = self._import_view(existing, duplicate=True)
        if existing_view is not None:
            return existing_view

        rows = preview["rows"]
        warnings = list(preview["warnings"])
        inserted_snapshot_ids: list[tuple[str, int]] = []
        with self._sessions() as session:
            model = self._snapshot_model(kwargs["data_kind"])
            duplicate_rows = session.scalars(
                select(model).where(
                    model.dedupe_key.in_([row["dedupe_key"] for row in rows])
                )
            ).all()
            duplicate_keys = {row.dedupe_key for row in duplicate_rows}
            if kwargs["data_kind"] == "content_performance":
                stored = session.scalars(select(model).where(
                    model.channel_id == kwargs["channel_id"], model.period_start == kwargs["period_start"],
                    model.period_end == kwargs["period_end"], model.grain == kwargs["grain"],
                )).all()
                by_target = {_content_target(row.canonical_url, row.published_content_id, row.title): row for row in stored}
                for row in rows:
                    prior = by_target.get(_content_target(row["canonical_url"], row["published_content_id"], row["title"]))
                    if prior is not None:
                        duplicate_keys.add(row["dedupe_key"])
                        if prior not in duplicate_rows:
                            duplicate_rows.append(prior)
            if duplicate_keys:
                warnings.append(
                    f"같은 source·기간·대상 snapshot {len(duplicate_keys)}건은 중복 저장하지 않았습니다."
                )
            if len(duplicate_keys) == len(rows):
                # Do not create an empty import run when an immutable snapshot already
                # owns every target in this source/period/grain. Corrections require
                # deleting that import first, which keeps the audit trail explicit.
                latest_duplicate = max(duplicate_rows, key=lambda row: row.id)
                existing_run = session.get(PerformanceImportRun, latest_duplicate.import_run_id)
                if existing_run is None:  # pragma: no cover - protected by the FK
                    raise RuntimeError("duplicate snapshot has no import run")
                for run_id in {row.import_run_id for row in duplicate_rows}:
                    self._refresh_import_recommendations(session, session.get(PerformanceImportRun, run_id))
                session.commit()
                view = self._import_view(existing_run, duplicate=True)
                view["warnings"] = [*view["warnings"], warnings[-1]]
                view["warning_count"] = len(view["warnings"])
                return view
            run = PerformanceImportRun(
                channel_id=kwargs["channel_id"],
                source=kwargs["source"],
                data_kind=kwargs["data_kind"],
                period_start=kwargs["period_start"],
                period_end=kwargs["period_end"],
                grain=kwargs["grain"],
                status="partial" if duplicate_keys else "ready",
                row_count=len(rows) - len(duplicate_keys),
                warning_count=len(warnings),
                input_hash=preview["input_hash"],
                warnings=warnings,
            )
            session.add(run)
            session.flush()
            for row in rows:
                if row["dedupe_key"] in duplicate_keys:
                    continue
                payload = {
                    **row,
                    "import_run_id": run.id,
                    "channel_id": kwargs["channel_id"],
                    "period_start": kwargs["period_start"],
                    "period_end": kwargs["period_end"],
                    "grain": kwargs["grain"],
                }
                snapshot = model(**payload)
                session.add(snapshot)
                session.flush()
                inserted_snapshot_ids.append((kwargs["data_kind"], snapshot.id))
            self._refresh_recommendations(session, inserted_snapshot_ids)
            session.commit()
            return self._import_view(run, duplicate=False)

    @staticmethod
    def _snapshot_model(data_kind: str):
        return {
            "content_performance": ContentPerformanceSnapshot,
            "query_performance": QueryPerformanceSnapshot,
            "commerce_attribution": CommerceAttributionSnapshot,
            "site_performance": SitePerformanceSnapshot,
        }[data_kind]

    @staticmethod
    def _import_view(row: PerformanceImportRun, *, duplicate: bool = False) -> dict:
        return {
            "id": row.id,
            "channel_id": row.channel_id,
            "source": row.source,
            "data_kind": row.data_kind,
            "period": {"start": row.period_start.isoformat(), "end": row.period_end.isoformat()},
            "grain": row.grain,
            "status": row.status,
            "row_count": row.row_count,
            "warning_count": row.warning_count,
            "warnings": list(row.warnings or []),
            "input_hash": row.input_hash,
            "collected_at": _iso(row.collected_at),
            "duplicate": duplicate,
        }

    def list_imports(self, *, limit: int = 30, channel_id: int | None = None) -> dict:
        with self._sessions() as session:
            rows = session.scalars(
                select(PerformanceImportRun)
                .where(PerformanceImportRun.channel_id == channel_id if channel_id is not None else True)
                .order_by(PerformanceImportRun.created_at.desc(), PerformanceImportRun.id.desc())
                .limit(limit)
            ).all()
            return {"items": [self._import_view(row) for row in rows]}

    def delete_import(self, import_id: int) -> bool:
        with self._sessions() as session:
            run = session.get(PerformanceImportRun, import_id)
            if run is None:
                return False
            for kind, model in (
                ("content_performance", ContentPerformanceSnapshot),
                ("query_performance", QueryPerformanceSnapshot),
                ("commerce_attribution", CommerceAttributionSnapshot),
                ("site_performance", SitePerformanceSnapshot),
            ):
                snapshot_ids = session.scalars(
                    select(model.id).where(model.import_run_id == import_id)
                ).all()
                if not snapshot_ids:
                    continue
                session.execute(
                    delete(PerformanceRecommendation).where(
                        PerformanceRecommendation.source_snapshot_type == kind,
                        PerformanceRecommendation.source_snapshot_id.in_(snapshot_ids),
                    )
                )
            session.delete(run)
            session.commit()
            return True

    def map_content_snapshot(self, snapshot_id: int, published_content_id: int) -> dict | None:
        with self._sessions() as session:
            row = session.get(ContentPerformanceSnapshot, snapshot_id)
            publication = session.get(PublishedContent, published_content_id)
            if row is None:
                return None
            if publication is None:
                raise ValueError("published content not found")
            if row.canonical_url and normalize_public_url(publication.canonical_url) != row.canonical_url:
                raise ValueError("canonical_url conflicts with published content")
            row.published_content_id = publication.id
            self._refresh_recommendations(session, [("content_performance", row.id)])
            session.commit()
            return self._content_view(session, row)

    def overview(self, *, channel_id: int | None = None, import_id: int | None = None) -> dict:
        with self._sessions() as session:
            if import_id is not None:
                selected = session.get(PerformanceImportRun, import_id)
                if selected is None or (channel_id is not None and selected.channel_id != channel_id):
                    raise ValueError("selected performance import not found for channel")
            creator = self._latest_kind_summary(session, "content_performance", channel_id, import_id)
            commerce = self._latest_kind_summary(session, "commerce_attribution", channel_id, import_id)
            website = self._latest_kind_summary(session, "site_performance", channel_id, import_id)
            return {
                "creator": creator,
                "commerce": commerce,
                "website": website,
                "sources_combined": False,
                "note": "Creator, Biz, Search Advisor 수치는 서로 합산하지 않습니다.",
            }

    def _latest_kind_summary(self, session: Session, data_kind: str, channel_id: int | None = None, import_id: int | None = None) -> dict | None:
        run = session.scalar(
            select(PerformanceImportRun)
            .join(OwnedChannel, OwnedChannel.id == PerformanceImportRun.channel_id)
            .where(
                PerformanceImportRun.data_kind == data_kind,
                OwnedChannel.enabled.is_(True),
                PerformanceImportRun.channel_id == channel_id if channel_id is not None else True,
                PerformanceImportRun.id == import_id if import_id is not None else True,
            )
            .order_by(PerformanceImportRun.period_end.desc(), PerformanceImportRun.id.desc())
        )
        if run is None:
            return None
        previous = session.scalar(
            select(PerformanceImportRun)
            .where(
                PerformanceImportRun.data_kind == data_kind,
                PerformanceImportRun.channel_id == run.channel_id,
                PerformanceImportRun.grain == run.grain,
                _previous_period(PerformanceImportRun, run),
            )
            .order_by(PerformanceImportRun.period_end.desc(), PerformanceImportRun.id.desc())
        )
        current_rows = self._scope_rows(session, run)
        previous_rows = self._scope_rows(session, previous) if previous else []
        # A different set of imported targets is not evidence of performance change.
        comparable = previous_rows and {self._target_key(run.data_kind, row) for row in current_rows} == {
            self._target_key(run.data_kind, row) for row in previous_rows
        }
        current_metrics = self._aggregate_rows(run.data_kind, current_rows)
        previous_metrics = self._aggregate_rows(run.data_kind, previous_rows) if comparable else None
        changes: dict[str, float | None] = {}
        for key, current in current_metrics.items():
            prior = previous_metrics.get(key) if previous_metrics else None
            if current is None or prior in {None, 0}:
                changes[key] = None
            else:
                changes[key] = round((float(current) - float(prior)) / float(prior) * 100, 2)
        return {
            "source": run.source,
            "channel_id": run.channel_id,
            "data_kind": run.data_kind,
            "period": {"start": run.period_start.isoformat(), "end": run.period_end.isoformat()},
            "grain": run.grain,
            "status": self._summary_state(current_rows, current_metrics),
            "channel_name": session.get(OwnedChannel, run.channel_id).display_name,
            "aggregation_note": "표시된 채널·기간·단위의 모든 가져오기를 집계합니다. 결측이 있는 지표는 결측, 평균 순위는 노출 가중 평균입니다.",
            "collected_at": _iso(run.collected_at),
            "metrics": current_metrics,
            "previous_metrics": previous_metrics,
            "changes": changes,
            "row_count": len(current_rows),
        }

    @staticmethod
    def _target_key(kind, row):
        if kind == "content_performance":
            return _content_target(row.canonical_url, row.published_content_id, row.title)
        if kind == "commerce_attribution":
            return row.tracking_id
        return row.page_url

    def _scope_rows(self, session: Session, run: PerformanceImportRun) -> list:
        model = self._snapshot_model(run.data_kind)
        return list(session.scalars(select(model).where(
            model.channel_id == run.channel_id,
            model.period_start == run.period_start,
            model.period_end == run.period_end,
            model.grain == run.grain,
        )).all())

    @staticmethod
    def _summary_state(rows, metrics) -> str:
        states = {row.data_state for row in rows}
        if states == {"pending"}:
            return "pending"
        if states == {"unavailable"} or not any(value is not None for value in metrics.values()):
            return "unavailable" if states == {"unavailable"} else "partial"
        if states == {"observed_zero"}:
            return "observed_zero"
        return "partial" if states != {"ready"} or any(value is None for value in metrics.values()) else "ready"

    @staticmethod
    def _aggregate_rows(kind: str, rows: list) -> dict:
        def total(field):
            values = [getattr(row, field) if row.data_state not in {"pending", "unavailable"} else None for row in rows]
            return round(sum(values), 4) if values and all(value is not None for value in values) else None

        result = {field: total(field) for field in _METRIC_FIELDS[kind]
                  if field not in {"ctr", "conversion_rate", "average_rank"}}
        if kind == "commerce_attribution":
            result["conversion_rate"] = _weighted_ctr(result["inflows"], result["orders"])
        else:
            result["ctr"] = _weighted_ctr(result["impressions"], result["inflows" if kind == "content_performance" else "clicks"])
        if kind == "content_performance":
            weights = result["impressions"]
            complete = rows and all(row.average_rank is not None and row.impressions is not None for row in rows)
            result["average_rank"] = round(sum(row.average_rank * row.impressions for row in rows) / weights, 2) if complete and weights else None
        return result

    def contents(self, *, import_id: int | None = None, channel_id: int | None = None) -> dict:
        with self._sessions() as session:
            statement = (
                select(ContentPerformanceSnapshot)
                .join(OwnedChannel, OwnedChannel.id == ContentPerformanceSnapshot.channel_id)
                .where(OwnedChannel.enabled.is_(True), ContentPerformanceSnapshot.channel_id == channel_id if channel_id is not None else True)
                .order_by(
                    ContentPerformanceSnapshot.period_end.desc(),
                    ContentPerformanceSnapshot.id.desc(),
                )
            )
            if import_id is not None:
                run = session.get(PerformanceImportRun, import_id)
                if run is None or run.data_kind != "content_performance" or (channel_id is not None and run.channel_id != channel_id):
                    raise ValueError("content performance import not found")
                statement = statement.where(ContentPerformanceSnapshot.import_run_id == import_id)
            rows = session.scalars(statement).all()
            latest: list[ContentPerformanceSnapshot] = []
            seen: set[str] = set()
            for row in rows:
                target = _content_target(row.canonical_url, row.published_content_id, row.title)
                key = f"{row.channel_id}:{target}"
                if key in seen:
                    continue
                seen.add(key)
                latest.append(row)
            return {"items": [self._content_view(session, row) for row in latest]}

    def _content_view(self, session: Session, row: ContentPerformanceSnapshot) -> dict:
        publication = session.get(PublishedContent, row.published_content_id) if row.published_content_id else None
        previous = session.scalar(
            select(ContentPerformanceSnapshot)
            .where(
                ContentPerformanceSnapshot.channel_id == row.channel_id,
                ContentPerformanceSnapshot.id != row.id,
                _previous_period(ContentPerformanceSnapshot, row),
                ContentPerformanceSnapshot.data_state.in_(["ready", "partial", "observed_zero"]),
                _same_content_target(row),
            )
            .order_by(ContentPerformanceSnapshot.period_end.desc(), ContentPerformanceSnapshot.id.desc())
        )
        market = self._market_context(session, publication.keyword_id if publication else None)
        return {
            "id": row.id,
            "channel_id": row.channel_id,
            "published_content_id": row.published_content_id,
            "canonical_url": row.canonical_url,
            "title": row.title or (publication.title if publication else ""),
            "keyword": market.get("keyword") or "",
            "period": {"start": row.period_start.isoformat(), "end": row.period_end.isoformat()},
            "grain": row.grain,
            "data_state": row.data_state,
            "metrics": self._content_metrics(row),
            "previous_metrics": self._content_metrics(previous) if previous else None,
            "market": market,
            "mapped": row.published_content_id is not None,
        }

    @staticmethod
    def _content_metrics(row: ContentPerformanceSnapshot) -> dict:
        return {
            "views": row.views,
            "impressions": row.impressions,
            "inflows": row.inflows,
            "ctr": row.ctr,
            "average_rank": row.average_rank,
            "likes": row.likes,
            "comments": row.comments,
        }

    def _market_context(self, session: Session, keyword_id: int | None) -> dict:
        if keyword_id is None:
            return {"keyword": "", "searchad": None, "trend": None, "serp": None}
        keyword = session.get(Keyword, keyword_id)
        snapshot = session.scalar(
            select(KeywordSnapshot)
            .where(KeywordSnapshot.keyword_id == keyword_id)
            .order_by(KeywordSnapshot.collected_at.desc(), KeywordSnapshot.id.desc())
        )
        serp = session.scalar(
            select(SerpSnapshot)
            .where(SerpSnapshot.keyword_id == keyword_id)
            .order_by(SerpSnapshot.collected_at.desc(), SerpSnapshot.id.desc())
        )
        metric = snapshot.payload.get("metric") if snapshot and isinstance(snapshot.payload, dict) else None
        trend = snapshot.payload.get("trend") if snapshot and isinstance(snapshot.payload, dict) else None
        monthly = None
        if isinstance(metric, dict):
            pc = metric.get("monthly_pc_searches")
            mobile = metric.get("monthly_mobile_searches")
            if all(isinstance(value, (int, float)) and not isinstance(value, bool)
                   and math.isfinite(value) and value >= 0 for value in (pc, mobile)):
                monthly = int(pc) + int(mobile)
        points = trend.get("points", []) if isinstance(trend, dict) else []
        latest_ratio = points[-1].get("ratio") if points and isinstance(points[-1], dict) else None
        serp_results = serp.payload.get("results", []) if serp and isinstance(serp.payload, dict) else []
        serp_sample = [item for item in serp_results[:10] if isinstance(item, dict)] if isinstance(serp_results, list) else []
        serp_ranks = [item.get("rank") for item in serp_sample if isinstance(item.get("rank"), (int, float))]
        return {
            "keyword": keyword.text if keyword else "",
            "searchad": {
                "monthly_searches": monthly,
                "source": "SEARCH_AD",
                "collected_at": _iso(snapshot.collected_at) if snapshot and metric else None,
            } if metric else None,
            "trend": {
                "latest_ratio": latest_ratio,
                "source": "NAVER_API_HUB",
                "collected_at": _iso(snapshot.collected_at) if snapshot and trend else None,
                "note": "상대 추세이며 절대 검색량이 아닙니다.",
            } if trend else None,
            "serp": {
                "sample_count": len(serp_sample),
                "blog_count": sum(item.get("result_type") == "blog" for item in serp_sample),
                "ad_count": sum(bool(item.get("is_ad")) for item in serp_sample),
                "median_observed_rank": float(median(serp_ranks)) if serp_ranks else None,
                "source": "BROWSER_DOM",
                "collected_at": _iso(serp.collected_at),
                "note": "사용자가 수집한 현재 검색 화면의 최대 10개 표본입니다.",
            } if serp else None,
        }

    def queries(self, *, import_id: int | None = None, channel_id: int | None = None) -> dict:
        with self._sessions() as session:
            statement = (
                select(QueryPerformanceSnapshot)
                .join(OwnedChannel, OwnedChannel.id == QueryPerformanceSnapshot.channel_id)
                .where(OwnedChannel.enabled.is_(True), QueryPerformanceSnapshot.channel_id == channel_id if channel_id is not None else True)
                .order_by(
                    QueryPerformanceSnapshot.period_end.desc(),
                    QueryPerformanceSnapshot.inflows.desc(),
                    QueryPerformanceSnapshot.id.desc(),
                )
            )
            if import_id is not None:
                run = session.get(PerformanceImportRun, import_id)
                if run is None or run.data_kind != "query_performance" or (channel_id is not None and run.channel_id != channel_id):
                    raise ValueError("query performance import not found")
                statement = statement.where(QueryPerformanceSnapshot.import_run_id == import_id)
            rows = session.scalars(statement).all()
            latest: list[QueryPerformanceSnapshot] = []
            seen: set[str] = set()
            for row in rows:
                key = f"{row.channel_id}:{row.query}:{row.published_content_id or row.canonical_url or ''}"
                if key in seen:
                    continue
                seen.add(key)
                latest.append(row)
            return {
                "items": [
                    {
                        "id": row.id,
                        "channel_id": row.channel_id,
                        "published_content_id": row.published_content_id,
                        "query": row.query,
                        "canonical_url": row.canonical_url,
                        "period": {"start": row.period_start.isoformat(), "end": row.period_end.isoformat()},
                        "grain": row.grain,
                        "data_state": row.data_state,
                        "metrics": {
                            "impressions": row.impressions,
                            "inflows": row.inflows,
                            "ctr": row.ctr,
                            "average_rank": row.average_rank,
                        },
                    }
                    for row in latest
                ]
            }

    def recommendations(self, *, status: str = "open", limit: int = 50, channel_id: int | None = None) -> dict:
        with self._sessions() as session:
            rows = session.scalars(
                select(PerformanceRecommendation)
                .join(OwnedChannel, OwnedChannel.id == PerformanceRecommendation.channel_id)
                .where(
                    PerformanceRecommendation.status == status,
                    PerformanceRecommendation.channel_id == channel_id if channel_id is not None else True,
                    OwnedChannel.enabled.is_(True),
                )
                .order_by(
                    PerformanceRecommendation.period_end.desc(),
                    PerformanceRecommendation.id.desc(),
                )
            ).all()
            if status == "open":
                rows = [row for row in rows if actionable_recommendation(session, row)]
            return {"items": [self._recommendation_view(session, row) for row in rows[:limit]]}

    @staticmethod
    def _recommendation_view(session: Session, row: PerformanceRecommendation) -> dict:
        publication = session.get(PublishedContent, row.published_content_id) if row.published_content_id else None
        publication_keyword = session.get(Keyword, publication.keyword_id) if publication else None
        return {
            "id": row.id,
            "channel_id": row.channel_id,
            "published_content_id": row.published_content_id,
            "draft_id": publication.draft_id if publication else None,
            "published_title": publication.title if publication else None,
            "published_url": publication.canonical_url if publication else None,
            "published_keyword": publication_keyword.text if publication_keyword else None,
            "keyword": row.keyword,
            "rule_code": row.rule_code,
            "action": row.action,
            "reason": row.reason,
            "confidence": row.confidence,
            "calculation_version": row.calculation_version,
            "period": {"start": row.period_start.isoformat(), "end": row.period_end.isoformat()},
            "evidence": row.evidence,
            "status": row.status,
            "created_at": _iso(row.created_at),
        }

    def update_recommendation(self, recommendation_id: int, *, status: str) -> dict | None:
        if status not in {"open", "dismissed", "done"}:
            raise ValueError("recommendation status is invalid")
        with self._sessions() as session:
            row = session.get(PerformanceRecommendation, recommendation_id)
            if row is None:
                return None
            row.status = status
            session.commit()
            return self._recommendation_view(session, row)

    def _refresh_recommendations(
        self, session: Session, snapshots: list[tuple[str, int]]
    ) -> None:
        for kind, snapshot_id in snapshots:
            if kind == "content_performance":
                row = session.get(ContentPerformanceSnapshot, snapshot_id)
                if row is not None:
                    self._content_recommendations(session, row)
            elif kind == "query_performance":
                row = session.get(QueryPerformanceSnapshot, snapshot_id)
                if row is not None:
                    self._query_recommendations(session, row)

    def _refresh_import_recommendations(self, session: Session, run: PerformanceImportRun) -> None:
        model = self._snapshot_model(run.data_kind)
        ids = session.scalars(select(model.id).where(model.import_run_id == run.id)).all()
        self._refresh_recommendations(session, [(run.data_kind, item) for item in ids])

    def _content_recommendations(self, session: Session, row: ContentPerformanceSnapshot) -> None:
        if row.data_state not in {"ready", "partial"} or not _recent_period(row.period_end):
            return
        publication = session.get(PublishedContent, row.published_content_id) if row.published_content_id else None
        if publication is not None and publication.archived_at is not None:
            return
        keyword = ""
        market: dict[str, Any] = {"searchad": None, "trend": None, "serp": None}
        if publication is not None:
            keyword_row = session.get(Keyword, publication.keyword_id)
            keyword = keyword_row.text if keyword_row else ""
            market = self._market_context(session, publication.keyword_id)
        keyword = keyword or row.title or "성과 개선"
        rules: list[dict] = []
        peer_ctrs = session.scalars(
            select(ContentPerformanceSnapshot.ctr).where(
                ContentPerformanceSnapshot.import_run_id == row.import_run_id,
                ContentPerformanceSnapshot.impressions >= 100,
                ContentPerformanceSnapshot.ctr.is_not(None),
            )
        ).all()
        benchmark_ctr = round(float(median(peer_ctrs)), 4) if len(peer_ctrs) >= 3 else 2.0
        if (
            row.impressions is not None
            and row.impressions >= 100
            and row.ctr is not None
            and row.ctr < benchmark_ctr
        ):
            market = {
                **market,
                "creator_benchmark": {
                    "metric": "ctr",
                    "median": benchmark_ctr,
                    "sample_count": len(peer_ctrs),
                    "note": "같은 가져오기 표본의 중앙값이며 표본이 3개 미만이면 2% 기준을 사용합니다.",
                },
            }
            rules.append(
                {
                    "rule_code": "high_impressions_low_ctr",
                    "action": "improve_title",
                    "reason": f"노출 {row.impressions:,}회에 비해 유입률이 {row.ctr:.2f}%로 기준 {benchmark_ctr:.2f}%보다 낮습니다. 제목과 검색 의도 일치도를 먼저 점검하세요.",
                    "confidence": "high" if row.impressions >= 500 else "medium",
                }
            )
        previous = session.scalar(
            select(ContentPerformanceSnapshot)
            .where(
                ContentPerformanceSnapshot.channel_id == row.channel_id,
                ContentPerformanceSnapshot.id != row.id,
                _previous_period(ContentPerformanceSnapshot, row),
                ContentPerformanceSnapshot.data_state.in_(["ready", "partial", "observed_zero"]),
                _same_content_target(row),
            )
            .order_by(ContentPerformanceSnapshot.period_end.desc(), ContentPerformanceSnapshot.id.desc())
        )
        rank_drop = (
            previous is not None
            and previous.average_rank is not None
            and row.average_rank is not None
            and row.average_rank - previous.average_rank >= 3
        )
        stale = publication is not None and publication_state(publication, now=_utcnow()) == "stale"
        if rank_drop or stale:
            reason = (
                f"평균 노출 순위가 {previous.average_rank:.1f}위에서 {row.average_rank:.1f}위로 하락했습니다."
                if rank_drop and previous
                else "공개 후 90일 이상 지난 글입니다."
            )
            rules.append(
                {
                    "rule_code": "rank_drop_or_stale",
                    "action": "refresh_body",
                    "reason": f"{reason} 최신 정보와 본문 구조를 확인하세요.",
                    "confidence": "high" if rank_drop else "medium",
                }
            )
        searchad = market.get("searchad") if isinstance(market, dict) else None
        monthly = searchad.get("monthly_searches") if isinstance(searchad, dict) else None
        if isinstance(monthly, int) and monthly >= 1000 and row.impressions is not None and row.impressions < 50:
            rules.append(
                {
                    "rule_code": "high_demand_low_exposure",
                    "action": "refresh_body",
                    "reason": f"SearchAd 월간 검색량은 {monthly:,}이지만 내 노출은 {row.impressions or 0:,}회입니다. 수요와 내 성과를 합산하지 않고 주제 적합성을 다시 확인하세요.",
                    "confidence": "medium",
                }
            )
        for rule in rules:
            self._upsert_recommendation(
                session,
                row=row,
                kind="content_performance",
                keyword=keyword,
                market=market,
                **rule,
            )

    def _query_recommendations(self, session: Session, row: QueryPerformanceSnapshot) -> None:
        if (
            row.data_state not in {"ready", "partial"}
            or not _recent_period(row.period_end)
            or (row.inflows or 0) < 10
        ):
            return
        if _has_followup_content(session, row):
            return
        previous = session.scalar(
            select(QueryPerformanceSnapshot)
            .where(
                QueryPerformanceSnapshot.channel_id == row.channel_id,
                _same_query_target(row),
                QueryPerformanceSnapshot.id != row.id,
                _previous_period(QueryPerformanceSnapshot, row),
                QueryPerformanceSnapshot.data_state.in_(["ready", "partial", "observed_zero"]),
            )
            .order_by(QueryPerformanceSnapshot.period_end.desc(), QueryPerformanceSnapshot.id.desc())
        )
        if previous is None or previous.inflows is None or previous.inflows <= 0:
            return
        growth = (row.inflows - previous.inflows) / previous.inflows * 100
        if growth < 50:
            return
        self._upsert_recommendation(
            session,
            row=row,
            kind="query_performance",
            keyword=row.query,
            rule_code="rising_query_followup",
            action="create_followup",
            reason=f"이 검색어 유입이 이전 동일 단위보다 {growth:.0f}% 증가했습니다. 별도 후속 글의 필요성을 검토하세요.",
            confidence="high" if row.inflows >= 50 else "medium",
            market={"creator_query": {"previous_inflows": previous.inflows, "current_inflows": row.inflows}},
        )

    @staticmethod
    def _upsert_recommendation(
        session: Session,
        *,
        row: ContentPerformanceSnapshot | QueryPerformanceSnapshot,
        kind: str,
        keyword: str,
        rule_code: str,
        action: str,
        reason: str,
        confidence: str,
        market: dict,
    ) -> None:
        key = _hash_payload(
            {
                "kind": kind,
                "snapshot_id": row.id,
                "rule": rule_code,
                "version": CALCULATION_VERSION,
            }
        )
        evidence = {
            "sources_combined": False,
            "creator_snapshot": {
                "type": kind,
                "id": row.id,
                "data_state": row.data_state,
            },
            "market": market,
            "minimum_sample": 100 if rule_code == "high_impressions_low_ctr" else 10,
        }
        prior_decision = session.scalar(select(PerformanceRecommendation.status).where(
            PerformanceRecommendation.source_snapshot_type == kind,
            PerformanceRecommendation.source_snapshot_id == row.id,
            PerformanceRecommendation.rule_code == rule_code,
            PerformanceRecommendation.status.in_(["done", "dismissed"]),
        ).order_by(PerformanceRecommendation.id.desc()))
        statement = (
            sqlite_insert(PerformanceRecommendation)
            .values(
                recommendation_key=key,
                channel_id=row.channel_id,
                source_snapshot_type=kind,
                source_snapshot_id=row.id,
                published_content_id=row.published_content_id,
                keyword=keyword[:200],
                rule_code=rule_code,
                action=action,
                reason=reason[:500],
                confidence=confidence,
                calculation_version=CALCULATION_VERSION,
                period_start=row.period_start,
                period_end=row.period_end,
                evidence=evidence,
                status=prior_decision or "open",
            )
            .on_conflict_do_update(
                index_elements=[PerformanceRecommendation.recommendation_key],
                set_={
                    "published_content_id": row.published_content_id,
                    "keyword": keyword[:200],
                    "reason": reason[:500],
                    "confidence": confidence,
                    "evidence": evidence,
                },
            )
        )
        session.execute(statement)

    def build_tracking_link(
        self,
        *,
        destination_url: str,
        nt_source: str,
        nt_medium: str,
        nt_detail: str = "",
        nt_keyword: str = "",
        published_content_id: int | None = None,
    ) -> dict:
        destination = self._validate_smartstore_url(destination_url)
        self._validate_tracking_value(nt_source, field="nt_source", unicode=False)
        self._validate_tracking_value(nt_medium, field="nt_medium", unicode=False)
        if nt_detail:
            self._validate_tracking_value(nt_detail, field="nt_detail", unicode=True)
        if nt_keyword:
            self._validate_tracking_value(nt_keyword, field="nt_keyword", unicode=True)
        parsed = urlsplit(destination)
        reserved = {"nt_source", "nt_medium", "nt_detail", "nt_keyword"}
        query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key not in reserved]
        query.extend([("nt_source", nt_source), ("nt_medium", nt_medium)])
        if nt_detail:
            query.append(("nt_detail", nt_detail))
        if nt_keyword:
            query.append(("nt_keyword", nt_keyword))
        built = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))
        parameters = {
            "nt_source": nt_source,
            "nt_medium": nt_medium,
            "nt_detail": nt_detail or None,
            "nt_keyword": nt_keyword or None,
        }
        # Field boundaries and store identity must survive hashing. Never truncate
        # user fields into an ambiguous ID or exceed the import's 100-char cap.
        store_scope = (parsed.hostname.removeprefix("m."), parsed.path.strip("/").split("/")[0])
        tracking_id = "nc1_" + _hash_payload({"store": store_scope, "parameters": parameters})[:40]
        with self._sessions() as session:
            enabled_commerce = session.scalar(
                select(OwnedChannel.id).where(
                    OwnedChannel.source == "biz_advisor",
                    OwnedChannel.enabled.is_(True),
                )
            )
            if enabled_commerce is None:
                raise ValueError("an enabled SmartStore performance channel is required")
            if published_content_id is not None and session.get(PublishedContent, published_content_id) is None:
                raise ValueError("published content not found")
            link = session.scalar(
                select(PerformanceTrackingLink).where(
                    PerformanceTrackingLink.tracking_id == tracking_id
                )
            )
            if link is not None:
                if (
                    link.published_content_id is not None
                    and published_content_id is not None
                    and link.published_content_id != published_content_id
                ):
                    raise ValueError("tracking_id is already linked to another published content")
                link.published_content_id = published_content_id or link.published_content_id
                link.destination_url = built
                link.parameters = parameters
            else:
                link_count = session.scalar(select(func.count(PerformanceTrackingLink.id))) or 0
                if link_count >= 400:
                    raise ValueError("SmartStore tracking combinations are limited to 400")
                link = PerformanceTrackingLink(
                    tracking_id=tracking_id,
                    published_content_id=published_content_id,
                    destination_url=built,
                    parameters=parameters,
                )
                session.add(link)
            session.commit()
            link_id = link.id
            linked_publication_id = link.published_content_id
        return {
            "id": link_id,
            "url": built,
            "tracking_id": tracking_id,
            "published_content_id": linked_publication_id,
            "parameters": parameters,
            "attribution_note": "Biz Advisor 사용자 정의 채널 집계용이며 콘텐츠의 직접 매출을 증명하지 않습니다.",
        }

    @staticmethod
    def _validate_tracking_value(value: str, *, field: str, unicode: bool) -> None:
        pattern = _UNICODE_TRACKING if unicode else _ASCII_TRACKING
        if not pattern.fullmatch(value):
            allowed = "한글·영문·숫자와 -_." if unicode else "영문·숫자와 -_."
            raise ValueError(f"{field} must contain 1-100 characters using {allowed} only")

    @staticmethod
    def _validate_smartstore_url(value: str) -> str:
        normalized = _validate_http_url(value, field="destination_url")
        if _hostname(normalized) not in _SMARTSTORE_HOSTS:
            raise ValueError("destination_url must be a SmartStore or BrandStore URL")
        return normalized
