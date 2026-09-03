"""Local, versioned evidence briefs built from normalized keyword snapshots."""

from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import Draft, FactPack, FactPackVersion, Keyword, KeywordSnapshot
from intelligence.keyword.models import clean_title
from intelligence.questions import extract_candidates
from providers.models import SearchLandscape

FACTPACK_STATUSES = frozenset({"draft", "approved"})
FRESH_FOR = timedelta(days=30)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _freshness(collected_at: object, now: datetime) -> str:
    parsed = _parse_datetime(collected_at)
    if parsed is None:
        return "unknown"
    return "stale" if now - parsed > FRESH_FOR else "fresh"


def _source_meta(block: dict | None, snapshot: KeywordSnapshot, now: datetime) -> dict:
    block = block or {}
    collected_at = _parse_datetime(block.get("collected_at")) or snapshot.collected_at
    return {
        "collected_at": _iso(collected_at),
        "from_cache": bool(block.get("from_cache", False)),
        "freshness": _freshness(collected_at, now),
    }


def _evidence(
    evidence_id: str,
    kind: str,
    label: str,
    value: object,
    source_type: str,
    source_id: str,
    meta: dict,
    *,
    source_url: str | None = None,
    selected: bool = True,
) -> dict:
    return {
        "id": evidence_id,
        "kind": kind,
        "label": label,
        "value": value,
        "source_type": source_type,
        "source_url": source_url,
        "source_id": source_id,
        "collected_at": meta["collected_at"],
        "from_cache": meta["from_cache"],
        "freshness": meta["freshness"],
        "selected": selected,
    }


def _version_view(row: FactPackVersion) -> dict:
    return {
        "version": row.version,
        "status": row.status,
        "evidence": row.evidence,
        "warnings": row.warnings,
        "created_at": _iso(row.created_at),
    }


class FactPackService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        *,
        now: Callable[[], datetime] | None = None,
    ):
        self._sessions = session_factory
        self._now = now or _utcnow

    def _build(self, snapshot: KeywordSnapshot) -> tuple[list[dict], list[str]]:
        payload = snapshot.payload if isinstance(snapshot.payload, dict) else {}
        now = self._now()
        evidence: list[dict] = []
        warnings: list[str] = []

        metric = payload.get("metric") if isinstance(payload.get("metric"), dict) else None
        if metric is None:
            warnings.append("검색량 근거가 없습니다.")
        else:
            meta = _source_meta(metric, snapshot, now)
            evidence.append(
                _evidence(
                    "metric:volume",
                    "search_volume",
                    "월간 PC·모바일 검색량",
                    {
                        "pc": metric.get("monthly_pc_searches"),
                        "mobile": metric.get("monthly_mobile_searches"),
                        "masked": bool(metric.get("volume_masked", False)),
                        "competition": metric.get("ad_competition"),
                    },
                    str(metric.get("source") or "SEARCH_AD"),
                    f"keyword_snapshot:{snapshot.id}:metric",
                    meta,
                )
            )
            if meta["freshness"] == "stale":
                warnings.append("검색량 근거가 30일보다 오래되었습니다.")

        trend = payload.get("trend") if isinstance(payload.get("trend"), dict) else None
        points = trend.get("points", []) if trend else []
        valid_points = [
            point for point in points
            if isinstance(point, dict) and isinstance(point.get("ratio"), (int, float))
        ]
        if not valid_points:
            warnings.append("검색 추세 근거가 없습니다.")
        else:
            meta = _source_meta(trend, snapshot, now)
            first, latest = valid_points[0], valid_points[-1]
            evidence.append(
                _evidence(
                    "trend:summary",
                    "trend_summary",
                    "검색 추세 요약",
                    {
                        "first_period": first.get("period"),
                        "first_ratio": first.get("ratio"),
                        "latest_period": latest.get("period"),
                        "latest_ratio": latest.get("ratio"),
                        "point_count": len(valid_points),
                    },
                    str(trend.get("source") or "NAVER_API_HUB"),
                    f"keyword_snapshot:{snapshot.id}:trend",
                    meta,
                )
            )
            if meta["freshness"] == "stale":
                warnings.append("검색 추세 근거가 30일보다 오래되었습니다.")

        landscape_payload = (
            payload.get("landscape") if isinstance(payload.get("landscape"), dict) else None
        )
        landscape: SearchLandscape | None = None
        if landscape_payload is None:
            warnings.append("검색 결과 근거가 없습니다.")
        else:
            try:
                landscape = SearchLandscape.model_validate(landscape_payload)
            except ValueError:
                warnings.append("검색 결과 근거 형식이 일부 손상되어 제외했습니다.")
            if landscape is not None:
                meta = _source_meta(landscape_payload, snapshot, now)
                for index, candidate in enumerate(extract_candidates(landscape), start=1):
                    evidence.append(
                        _evidence(
                            f"question:{index}",
                            candidate["kind"],
                            "실제 질문" if candidate["kind"] == "question" else "경험·후기 주제",
                            candidate["text"],
                            "NAVER_API_HUB",
                            f"keyword_snapshot:{snapshot.id}:{candidate['channel']}:{index}",
                            meta,
                        )
                    )
                channels = (
                    ("blog", landscape.top_results),
                    ("kin", landscape.kin_items),
                    ("cafe", landscape.cafe_items),
                    ("news", landscape.news_items),
                )
                result_count = 0
                for channel, items in channels:
                    for item_index, item in enumerate(items[:3], start=1):
                        title = clean_title(item.title)
                        if not title:
                            continue
                        result_count += 1
                        evidence.append(
                            _evidence(
                                f"search:{channel}:{item_index}",
                                "search_result",
                                f"{channel} 검색 결과",
                                {"title": title, "posted_at": item.posted_at},
                                "NAVER_API_HUB",
                                f"keyword_snapshot:{snapshot.id}:{channel}:{item_index}",
                                meta,
                                source_url=item.link or None,
                                selected=False,
                            )
                        )
                if result_count == 0:
                    warnings.append("검색 결과 메타데이터가 비어 있습니다.")
                if meta["freshness"] == "stale":
                    warnings.append("검색 결과 근거가 30일보다 오래되었습니다.")

        if isinstance(snapshot.score, dict) and snapshot.score:
            score_meta = {
                "collected_at": _iso(snapshot.collected_at),
                "from_cache": False,
                "freshness": _freshness(snapshot.collected_at, now),
            }
            evidence.append(
                _evidence(
                    "score:opportunity",
                    "derived_score",
                    "콘텐츠 기회 점수",
                    {
                        "value": snapshot.score.get("value"),
                        "confidence": snapshot.score.get("confidence"),
                        "score_version": snapshot.score_version,
                    },
                    "DERIVED",
                    f"keyword_snapshot:{snapshot.id}:score",
                    score_meta,
                )
            )
        else:
            warnings.append("파생 기회 점수가 없습니다.")

        if not evidence:
            warnings.append("선택할 수 있는 정규화 근거가 없습니다.")
        return evidence, list(dict.fromkeys(warnings))

    def create(self, snapshot_id: int, *, draft_id: int | None = None) -> dict:
        with self._sessions() as session:
            snapshot = session.get(KeywordSnapshot, snapshot_id)
            if snapshot is None:
                raise ValueError("snapshot not found")
            keyword = session.get(Keyword, snapshot.keyword_id)
            if keyword is None:
                raise ValueError("snapshot keyword not found")
            if draft_id is not None:
                draft = session.get(Draft, draft_id)
                if draft is None:
                    raise ValueError("draft not found")
                if draft.keyword_id != snapshot.keyword_id:
                    raise ValueError("draft keyword does not match snapshot")
                if draft.source_snapshot_id not in {None, snapshot.id}:
                    raise ValueError("draft snapshot does not match FactPack snapshot")
            evidence, warnings = self._build(snapshot)
            pack = FactPack(
                snapshot_id=snapshot.id,
                keyword_id=snapshot.keyword_id,
                draft_id=draft_id,
            )
            session.add(pack)
            session.flush()
            version = FactPackVersion(
                fact_pack_id=pack.id,
                version=1,
                status="draft",
                evidence=evidence,
                warnings=warnings,
            )
            session.add(version)
            session.commit()
            return self.get(pack.id)  # type: ignore[return-value]

    def get(self, fact_pack_id: int) -> dict | None:
        with self._sessions() as session:
            pack = session.get(FactPack, fact_pack_id)
            if pack is None:
                return None
            keyword = session.get(Keyword, pack.keyword_id)
            versions = session.scalars(
                select(FactPackVersion)
                .where(FactPackVersion.fact_pack_id == fact_pack_id)
                .order_by(FactPackVersion.version)
            ).all()
            latest = versions[-1] if versions else None
            return {
                "fact_pack_id": pack.id,
                "snapshot_id": pack.snapshot_id,
                "draft_id": pack.draft_id,
                "keyword": keyword.text if keyword else "",
                "created_at": _iso(pack.created_at),
                "latest_version": latest.version if latest else 0,
                "latest_status": latest.status if latest else "draft",
                "versions": [_version_view(row) for row in versions],
            }

    def append_version(
        self,
        fact_pack_id: int,
        *,
        selected_evidence_ids: list[str],
        status: str = "draft",
    ) -> dict | None:
        if status not in FACTPACK_STATUSES:
            raise ValueError("invalid FactPack status")
        selected = set(selected_evidence_ids)
        if len(selected) != len(selected_evidence_ids):
            raise ValueError("selected evidence ids must be unique")
        with self._sessions() as session:
            pack = session.get(FactPack, fact_pack_id)
            if pack is None:
                return None
            latest = session.scalar(
                select(FactPackVersion)
                .where(FactPackVersion.fact_pack_id == fact_pack_id)
                .order_by(FactPackVersion.version.desc())
            )
            if latest is None:
                raise ValueError("FactPack has no version")
            known = {str(item.get("id")) for item in latest.evidence}
            unknown = selected - known
            if unknown:
                raise ValueError(f"unknown evidence id: {sorted(unknown)[0]}")
            if status == "approved" and not selected:
                raise ValueError("approved FactPack requires selected evidence")
            copied = deepcopy(latest.evidence)
            for item in copied:
                item["selected"] = item.get("id") in selected
            session.add(
                FactPackVersion(
                    fact_pack_id=pack.id,
                    version=latest.version + 1,
                    status=status,
                    evidence=copied,
                    warnings=deepcopy(latest.warnings),
                )
            )
            session.commit()
        return self.get(fact_pack_id)

    def approved_context(
        self,
        keyword_text: str,
        snapshot_id: int | None,
        fact_pack_id: int | None,
        fact_pack_version: int | None,
    ) -> list[dict]:
        if fact_pack_id is None and fact_pack_version is None:
            return []
        if fact_pack_id is None or fact_pack_version is None:
            raise ValueError("fact_pack_id and fact_pack_version must be provided together")
        if snapshot_id is None:
            raise ValueError("FactPack requires source snapshot_id")
        with self._sessions() as session:
            pack = session.get(FactPack, fact_pack_id)
            version = session.scalar(
                select(FactPackVersion).where(
                    FactPackVersion.fact_pack_id == fact_pack_id,
                    FactPackVersion.version == fact_pack_version,
                )
            )
            keyword = session.get(Keyword, pack.keyword_id) if pack is not None else None
            if pack is None or version is None:
                raise ValueError("FactPack version not found")
            if keyword is None or keyword.text != keyword_text:
                raise ValueError("FactPack keyword does not match draft keyword")
            if pack.snapshot_id != snapshot_id:
                raise ValueError("FactPack snapshot does not match draft snapshot")
            if version.status != "approved":
                raise ValueError("FactPack version is not approved")
            return [deepcopy(item) for item in version.evidence if item.get("selected")]


def render_approved_evidence(evidence: list[dict]) -> str:
    """Render only the reviewed compact fields; raw provider payload is never accepted here."""
    if not evidence:
        return ""
    lines = [
        "검토 승인된 FactPack 근거(아래 항목만 사실 근거로 사용하고, 빈 부분은 단정하지 마세요):"
    ]
    for item in evidence:
        value = json.dumps(item.get("value"), ensure_ascii=False, separators=(",", ":"))
        source = str(item.get("source_type") or "UNKNOWN")
        locator = item.get("source_url") or item.get("source_id") or ""
        lines.append(f"- {item.get('label')}: {value} (출처: {source}; {locator})")
    return "\n".join(lines)
