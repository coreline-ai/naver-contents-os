"""Research workspace orchestration.

All external calls are explicit user actions. SearchAd account access is read-only,
and every provider continues to use the shared cache/quota gateway.
"""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Callable, TypeVar

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.errors import CoreError
from app.models_db import Draft, Keyword, KeywordSnapshot, WatchlistItem
from intelligence.cluster import cluster_keywords
from intelligence.keyword.models import compact, normalize_keyword
from providers.models import KeywordMetric, TrendSeries
from providers.naver_hub.client import (
    NaverHubSearchClient,
    NaverHubShoppingClient,
    NaverHubTrendClient,
)
from providers.searchad.client import NaverSearchAdClient

T = TypeVar("T")

GRAPH_FIRST_HOP_CAP = 30
GRAPH_SECOND_SEED_CAP = 5
GRAPH_NODE_CAP = 80
GRAPH_ENRICH_CAP = 5
WATCHLIST_CAP = 50
ACCOUNT_ADGROUP_CAP = 20
ACCOUNT_KEYWORD_CAP = 100


def _iso(value: datetime | str | None = None) -> str:
    if isinstance(value, str):
        return value
    return (value or datetime.now(timezone.utc)).isoformat()


def _volume(metric: KeywordMetric | dict | None) -> int | None:
    if metric is None:
        return None
    if isinstance(metric, KeywordMetric):
        return metric.monthly_total_searches
    pc = metric.get("monthly_pc_searches")
    mobile = metric.get("monthly_mobile_searches")
    if pc is None or mobile is None:
        return None
    return int(pc) + int(mobile)


def _metric_key(keyword: str) -> str:
    return compact(normalize_keyword(keyword))


def _rows(value) -> list[dict]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if not isinstance(value, dict):
        return []
    for key in ("items", "data", "estimate", "estimates", "result", "results"):
        candidate = value.get(key)
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)]
    return [value] if value else []


def _number(row: dict | None, *keys: str) -> float | None:
    if row is None:
        return None
    for key in keys:
        value = row.get(key)
        try:
            if value is not None and value != "":
                return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _estimate_index(value, keywords: list[str]) -> dict[str, dict]:
    rows = _rows(value)
    result: dict[str, dict] = {}
    for index, row in enumerate(rows):
        keyword = str(
            row.get("keyword")
            or row.get("key")
            or row.get("relKeyword")
            or (keywords[index] if index < len(keywords) else "")
        )
        if keyword:
            result[_metric_key(keyword)] = row
    return result


class ResearchService:
    def __init__(
        self,
        session_factory: sessionmaker[Session],
        searchad: NaverSearchAdClient | None,
        hub_search: NaverHubSearchClient | None,
        hub_trend: NaverHubTrendClient | None,
        hub_shopping: NaverHubShoppingClient | None = None,
    ):
        self._sessions = session_factory
        self._searchad = searchad
        self._hub_search = hub_search
        self._hub_trend = hub_trend
        self._hub_shopping = hub_shopping

    @staticmethod
    def _safe(call: Callable[[], T]) -> tuple[T | None, str]:
        try:
            return call(), "ok"
        except CoreError as exc:
            return None, exc.code
        except ValueError:
            return None, "request"

    def capabilities(self) -> dict:
        def provider(client, features: list[str]) -> dict:
            if client is None:
                return {"status": "unconfigured", "features": features, "quota": None}
            # Credentials are present, but individual API permissions are only
            # known after an explicit live request.
            return {"status": "configured", "features": features, "quota": client.usage_status()}

        return {
            "collected_at": _iso(),
            "providers": {
                "hub_search": provider(
                    self._hub_search, ["search", "preflight", "local", "image"]
                ),
                "hub_trend": provider(self._hub_trend, ["trend", "audience"]),
                "hub_shopping": provider(self._hub_shopping, ["shopping"]),
                "searchad": provider(
                    self._searchad,
                    ["keyword_graph", "commercial_estimate", "account_performance"],
                ),
            },
            "searchad_access": "read_only",
        }

    def snapshot(self, snapshot_id: int) -> dict | None:
        with self._sessions() as session:
            row = session.get(KeywordSnapshot, snapshot_id)
            if row is None:
                return None
            keyword = session.get(Keyword, row.keyword_id)
            return {
                "snapshot_id": row.id,
                "keyword": keyword.text if keyword else "",
                "collected_at": _iso(row.collected_at),
                "payload": row.payload,
                "score": row.score,
                "score_version": row.score_version,
            }

    def preflight(self, keyword: str, *, force_refresh: bool = False) -> dict:
        normalized = normalize_keyword(keyword)
        if self._hub_search is None:
            return {
                "keyword": normalized,
                "correction": None,
                "sensitive": None,
                "data_status": {"errata": "unconfigured", "adult": "unconfigured"},
                "collected_at": _iso(),
            }
        errata, errata_status = self._safe(
            lambda: self._hub_search.get_errata(normalized, force_refresh=force_refresh)
        )
        adult, adult_status = self._safe(
            lambda: self._hub_search.is_adult(normalized, force_refresh=force_refresh)
        )
        return {
            "keyword": normalized,
            "correction": errata["value"] if errata else None,
            "sensitive": adult["value"] if adult else None,
            "data_status": {"errata": errata_status, "adult": adult_status},
            "from_cache": bool(errata and adult and errata["from_cache"] and adult["from_cache"]),
            "collected_at": _iso(),
        }

    def _snapshot_metrics(self, snapshot_id: int | None, keyword: str) -> list[KeywordMetric]:
        if snapshot_id is None:
            return []
        snapshot = self.snapshot(snapshot_id)
        if snapshot is None or _metric_key(snapshot["keyword"]) != _metric_key(keyword):
            return []
        rows = snapshot.get("payload", {}).get("related_keywords", [])
        result: list[KeywordMetric] = []
        for row in rows:
            try:
                result.append(KeywordMetric.model_validate(row))
            except (TypeError, ValueError):
                continue
        return result

    def graph(
        self,
        keyword: str,
        *,
        snapshot_id: int | None = None,
        force_refresh: bool = False,
    ) -> dict:
        seed = normalize_keyword(keyword)
        if self._searchad is None:
            return {
                "keyword": seed,
                "status": "unconfigured",
                "nodes": [],
                "edges": [],
                "call_budget": {"actual": 0, "maximum": 12},
                "collected_at": _iso(),
            }

        actual_calls = 0
        first_metrics = self._snapshot_metrics(snapshot_id, seed)
        first_status = "snapshot" if first_metrics else "ok"
        if not first_metrics:
            first_metrics, first_status = self._safe(
                lambda: self._searchad.get_related_keywords(seed, force_refresh=force_refresh)
            )
            actual_calls += 1
            first_metrics = first_metrics or []

        by_key: dict[str, dict] = {
            _metric_key(seed): {
                "id": _metric_key(seed),
                "keyword": seed,
                "depth": 0,
                "volume": None,
                "volume_masked": False,
                "competition": None,
                "cluster": "seed",
                "blog_total": None,
                "trend_delta": None,
                "enrichment_status": "pending",
            }
        }
        metric_models: dict[str, KeywordMetric] = {}

        def sorted_metrics(values: list[KeywordMetric]) -> list[KeywordMetric]:
            return sorted(values, key=lambda metric: (_volume(metric) or -1, metric.keyword), reverse=True)

        first_hop = [
            metric
            for metric in sorted_metrics(first_metrics)
            if _metric_key(metric.keyword) != _metric_key(seed)
        ][:GRAPH_FIRST_HOP_CAP]
        edges: set[tuple[str, str]] = set()

        def add_node(metric: KeywordMetric, depth: int) -> None:
            key = _metric_key(metric.keyword)
            if not key or key in by_key or len(by_key) >= GRAPH_NODE_CAP:
                return
            metric_models[key] = metric
            by_key[key] = {
                "id": key,
                "keyword": metric.keyword,
                "depth": depth,
                "volume": _volume(metric),
                "volume_masked": metric.volume_masked,
                "competition": metric.ad_competition,
                "cluster": "기타",
                "blog_total": None,
                "trend_delta": None,
                "enrichment_status": "not_collected",
            }

        for metric in first_hop:
            add_node(metric, 1)
            target = _metric_key(metric.keyword)
            if target in by_key and target != _metric_key(seed):
                edges.add((_metric_key(seed), target))

        for parent_metric in first_hop[:GRAPH_SECOND_SEED_CAP]:
            children, status = self._safe(
                lambda metric=parent_metric: self._searchad.get_related_keywords(
                    metric.keyword, force_refresh=force_refresh
                )
            )
            actual_calls += 1
            if status != "ok":
                by_key[_metric_key(parent_metric.keyword)]["enrichment_status"] = status
                continue
            parent = _metric_key(parent_metric.keyword)
            for child in sorted_metrics(children or []):
                child_key = _metric_key(child.keyword)
                if child_key in {_metric_key(seed), parent}:
                    continue
                existing = by_key.get(child_key)
                if existing is not None and existing["depth"] <= 1:
                    # Keep the graph seed -> first hop -> second hop. Cross-links
                    # between expansion seeds can otherwise create directed cycles.
                    continue
                add_node(child, 2)
                if child_key in by_key and (parent, child_key) not in edges:
                    edges.add((parent, child_key))
                if len(by_key) >= GRAPH_NODE_CAP:
                    break

        clusters = cluster_keywords(list(metric_models.values()))
        for cluster in clusters:
            for cluster_keyword in cluster["keywords"]:
                node = by_key.get(_metric_key(cluster_keyword))
                if node:
                    node["cluster"] = cluster["label"]

        enrichment_nodes = sorted(
            [node for node in by_key.values() if node["depth"] > 0],
            key=lambda node: node["volume"] or -1,
            reverse=True,
        )[:GRAPH_ENRICH_CAP]
        if self._hub_search is not None:
            for node in enrichment_nodes:
                result, status = self._safe(
                    lambda node=node: self._hub_search.search(
                        "blog", node["keyword"], display=1, force_refresh=force_refresh
                    )
                )
                actual_calls += 1
                node["enrichment_status"] = status
                if result is not None:
                    node["blog_total"] = result.total
        if self._hub_trend is not None and enrichment_nodes:
            trend_rows, trend_status = self._safe(
                lambda: self._hub_trend.get_search_trends(
                    [(node["keyword"], [node["keyword"]]) for node in enrichment_nodes],
                    force_refresh=force_refresh,
                )
            )
            actual_calls += 1
            if trend_rows:
                for row in trend_rows:
                    node = by_key.get(_metric_key(row.keyword_group))
                    if node and row.points:
                        node["trend_delta"] = round(
                            row.points[-1].ratio - row.points[0].ratio, 2
                        )
            elif trend_status != "ok":
                for node in enrichment_nodes:
                    if node["enrichment_status"] == "ok":
                        node["enrichment_status"] = trend_status

        seed_node = by_key[_metric_key(seed)]
        exact = next(
            (metric for metric in first_metrics if _metric_key(metric.keyword) == _metric_key(seed)),
            None,
        )
        if exact:
            seed_node.update(
                volume=_volume(exact),
                volume_masked=exact.volume_masked,
                competition=exact.ad_competition,
            )
        seed_node["enrichment_status"] = first_status

        return {
            "keyword": seed,
            "snapshot_id": snapshot_id,
            "status": "ok" if first_status in {"ok", "snapshot"} else first_status,
            "nodes": list(by_key.values()),
            "edges": [{"source": source, "target": target} for source, target in sorted(edges)],
            "clusters": clusters,
            "call_budget": {"actual": actual_calls, "maximum": 12},
            "caps": {
                "first_hop": GRAPH_FIRST_HOP_CAP,
                "second_seeds": GRAPH_SECOND_SEED_CAP,
                "nodes": GRAPH_NODE_CAP,
                "enriched": GRAPH_ENRICH_CAP,
            },
            "collected_at": _iso(),
        }

    def commercial(
        self, keywords: list[str], *, device: str = "PC", force_refresh: bool = False
    ) -> dict:
        cleaned = list(dict.fromkeys(normalize_keyword(value) for value in keywords if value.strip()))[:20]
        if self._searchad is None:
            return {"status": "unconfigured", "rows": [], "score_version": "commercial-v1"}
        if not cleaned:
            return {"status": "empty", "rows": [], "score_version": "commercial-v1"}
        average, average_status = self._safe(
            lambda: self._searchad.estimate_average_position_bid(
                cleaned, device=device, force_refresh=force_refresh
            )
        )
        minimum, minimum_status = self._safe(
            lambda: self._searchad.estimate_exposure_minimum_bid(
                cleaned, device=device, force_refresh=force_refresh
            )
        )
        median, median_status = self._safe(
            lambda: self._searchad.estimate_median_bid(
                cleaned, device=device, force_refresh=force_refresh
            )
        )
        average_by_keyword = _estimate_index(average, cleaned)
        minimum_by_keyword = _estimate_index(minimum, cleaned)
        median_by_keyword = _estimate_index(median, cleaned)
        bulk_items = []
        for keyword in cleaned:
            median_row = median_by_keyword.get(_metric_key(keyword))
            bid = _number(median_row, "bid", "bidAmt", "medianBid", "value") or 1000
            bulk_items.append(
                {"device": device, "keywordplus": True, "keyword": keyword, "bid": int(bid)}
            )
        performance, performance_status = self._safe(
            lambda: self._searchad.estimate_performance_bulk(
                bulk_items, force_refresh=force_refresh
            )
        )
        performance_by_keyword = _estimate_index(performance, cleaned)
        rows = []
        for keyword in cleaned:
            key = _metric_key(keyword)
            average_bid = _number(
                average_by_keyword.get(key), "bid", "bidAmt", "averagePositionBid", "value"
            )
            minimum_bid = _number(
                minimum_by_keyword.get(key), "bid", "bidAmt", "minimumBid", "value"
            )
            median_bid = _number(
                median_by_keyword.get(key), "bid", "bidAmt", "medianBid", "value"
            )
            performance_row = performance_by_keyword.get(key)
            impressions = _number(performance_row, "impCnt", "impressions", "monthlyPcQcCnt")
            clicks = _number(performance_row, "clkCnt", "clicks")
            components = [
                min(100.0, math.log1p(value) / math.log1p(100_000) * 100)
                for value in (average_bid, minimum_bid, median_bid)
                if value is not None and value >= 0
            ]
            score = round(sum(components) / len(components), 1) if components else None
            rows.append(
                {
                    "keyword": keyword,
                    "device": device.upper(),
                    "average_position_bid": average_bid,
                    "minimum_exposure_bid": minimum_bid,
                    "median_bid": median_bid,
                    "estimated_impressions": impressions,
                    "estimated_clicks": clicks,
                    "commercial_score": score,
                }
            )
        statuses = {
            "average_position": average_status,
            "minimum_exposure": minimum_status,
            "median": median_status,
            "performance": performance_status,
        }
        return {
            "status": "ok" if all(value == "ok" for value in statuses.values()) else "partial",
            "data_status": statuses,
            "score_version": "commercial-v1",
            "score_note": "Organic Opportunity Score와 합산하지 않는 광고 입찰 기반 별도 지표",
            "rows": rows,
            "collected_at": _iso(),
        }

    def audience(self, keyword: str, *, force_refresh: bool = False) -> dict:
        normalized = normalize_keyword(keyword)
        if self._hub_trend is None:
            return {"keyword": normalized, "status": "unconfigured", "segments": {}}
        dimensions = {
            "device": [("pc", {"device": "pc"}), ("mo", {"device": "mo"})],
            "gender": [("m", {"gender": "m"}), ("f", {"gender": "f"})],
            "age": [(str(age), {"ages": [str(age)]}) for age in range(1, 12)],
        }
        result: dict[str, list[dict]] = {}
        statuses: dict[str, str] = {}
        for dimension, requests in dimensions.items():
            result[dimension] = []
            for label, filters in requests:
                rows, status = self._safe(
                    lambda filters=filters: self._hub_trend.get_search_trends(
                        [(normalized, [normalized])],
                        force_refresh=force_refresh,
                        **filters,
                    )
                )
                statuses[f"{dimension}:{label}"] = status
                if rows:
                    series = rows[0]
                    result[dimension].append(
                        {
                            "label": label,
                            "points": [point.model_dump(mode="json") for point in series.points],
                            "collected_at": _iso(series.collected_at),
                            "from_cache": series.from_cache,
                        }
                    )
        return {
            "keyword": normalized,
            "status": "ok" if all(value == "ok" for value in statuses.values()) else "partial",
            "data_status": statuses,
            "segments": result,
            "normalization": "independent",
            "warning": "각 series는 독립 정규화된 상대지수이며 절대 검색량·인구 비중이 아닙니다.",
            "collected_at": _iso(),
        }

    def specialized(
        self,
        keyword: str,
        mode: str,
        *,
        category: str = "",
        force_refresh: bool = False,
    ) -> dict:
        normalized = normalize_keyword(keyword)
        if mode == "local":
            if self._hub_search is None:
                return {"mode": mode, "keyword": normalized, "status": "unconfigured", "items": []}
            payload, status = self._safe(
                lambda: self._hub_search.search_local(normalized, force_refresh=force_refresh)
            )
            return {
                "mode": mode,
                "keyword": normalized,
                "status": status,
                "items": payload["items"] if payload else [],
                "total": payload.get("total") if payload else None,
                "plan_candidates": ["장소 비교", "방문 전 체크리스트", "지역별 이용 가이드"],
                "collected_at": _iso(),
            }
        if mode == "image":
            if self._hub_search is None:
                return {"mode": mode, "keyword": normalized, "status": "unconfigured", "items": []}
            payload, status = self._safe(
                lambda: self._hub_search.search_images(normalized, force_refresh=force_refresh)
            )
            return {
                "mode": mode,
                "keyword": normalized,
                "status": status,
                "items": payload["items"] if payload else [],
                "total": payload.get("total") if payload else None,
                "rights_notice": "검색 결과는 참고용입니다. 다운로드·재사용 전 원 출처의 권리를 확인하세요.",
                "collected_at": _iso(),
            }
        if mode == "shopping":
            if self._hub_shopping is None:
                return {"mode": mode, "keyword": normalized, "status": "unconfigured", "series": []}
            payload, status = self._safe(
                lambda: self._hub_shopping.get_keyword_trends(
                    category, [normalized], force_refresh=force_refresh
                )
            )
            return {
                "mode": mode,
                "keyword": normalized,
                "category": category,
                "status": status,
                "series": payload or [],
                "plan_candidates": ["제품 비교", "실사용 리뷰", "구매 가이드"],
                "warning": "쇼핑 클릭의 기간 내 상대지수이며 판매량이 아닙니다.",
                "collected_at": _iso(),
            }
        return {"mode": "general", "keyword": normalized, "status": "ok", "collected_at": _iso()}

    def _watchlist_view(self, session: Session, row: WatchlistItem) -> dict:
        keyword = session.get(Keyword, row.keyword_id)
        previous = row.previous_snapshot
        current = row.last_snapshot
        delta = None
        direction = "비교 불가"
        if (
            previous
            and current
            and previous.get("comparison_key") == current.get("comparison_key")
            and previous.get("latest_ratio") is not None
            and current.get("latest_ratio") is not None
        ):
            delta = round(float(current["latest_ratio"]) - float(previous["latest_ratio"]), 2)
            direction = "상승" if delta > 0 else "하락" if delta < 0 else "보합"
        stale = True
        if current and current.get("collected_at"):
            try:
                collected = datetime.fromisoformat(current["collected_at"])
                if collected.tzinfo is None:
                    collected = collected.replace(tzinfo=timezone.utc)
                stale = (datetime.now(timezone.utc) - collected).total_seconds() > 86_400
            except ValueError:
                pass
        return {
            "id": row.id,
            "keyword": keyword.text if keyword else "",
            "status": row.last_status,
            "comparison_key": row.comparison_key,
            "last_snapshot": current,
            "previous_snapshot": previous,
            "delta": delta,
            "direction": direction,
            "stale": stale,
            "created_at": _iso(row.created_at),
            "updated_at": _iso(row.updated_at),
        }

    def list_watchlist(self) -> dict:
        with self._sessions() as session:
            rows = session.scalars(select(WatchlistItem).order_by(WatchlistItem.id)).all()
            return {"items": [self._watchlist_view(session, row) for row in rows], "cap": WATCHLIST_CAP}

    def add_watchlist(self, keyword: str) -> dict:
        normalized = normalize_keyword(keyword)
        with self._sessions() as session:
            count = session.scalar(select(func.count(WatchlistItem.id))) or 0
            keyword_row = session.scalar(select(Keyword).where(Keyword.text == normalized))
            if keyword_row is None:
                keyword_row = Keyword(text=normalized)
                session.add(keyword_row)
                session.flush()
            existing = session.scalar(
                select(WatchlistItem).where(WatchlistItem.keyword_id == keyword_row.id)
            )
            if existing is not None:
                return self._watchlist_view(session, existing)
            if count >= WATCHLIST_CAP:
                raise ValueError(f"watchlist is limited to {WATCHLIST_CAP} items")
            row = WatchlistItem(keyword_id=keyword_row.id)
            session.add(row)
            session.commit()
            return self._watchlist_view(session, row)

    def delete_watchlist(self, item_id: int) -> bool:
        with self._sessions() as session:
            row = session.get(WatchlistItem, item_id)
            if row is None:
                return False
            session.delete(row)
            session.commit()
            return True

    def refresh_watchlist(self, item_ids: list[int], *, force_refresh: bool = False) -> dict:
        unique_ids = list(dict.fromkeys(item_ids))[:WATCHLIST_CAP]
        updated = []
        with self._sessions() as session:
            rows = session.scalars(
                select(WatchlistItem).where(WatchlistItem.id.in_(unique_ids)).order_by(WatchlistItem.id)
            ).all()
            for row in rows:
                keyword = session.get(Keyword, row.keyword_id)
                if keyword is None:
                    continue
                metric = None
                searchad_status = "unconfigured"
                if self._searchad is not None:
                    metrics, searchad_status = self._safe(
                        lambda keyword=keyword: self._searchad.get_related_keywords(
                            keyword.text, force_refresh=force_refresh
                        )
                    )
                    metric = next(
                        (
                            value
                            for value in metrics or []
                            if _metric_key(value.keyword) == _metric_key(keyword.text)
                        ),
                        None,
                    )
                trend: TrendSeries | None = None
                trend_status = "unconfigured"
                if self._hub_trend is not None:
                    trend, trend_status = self._safe(
                        lambda keyword=keyword: self._hub_trend.get_search_trend(
                            keyword.text, force_refresh=force_refresh
                        )
                    )
                comparison_key = "not-comparable"
                latest_ratio = None
                if trend and trend.points:
                    comparison_key = (
                        f"{trend.time_unit}:{trend.points[0].period}:{trend.points[-1].period}:"
                        f"{trend.device}:{trend.gender}:{','.join(trend.ages)}"
                    )
                    latest_ratio = trend.points[-1].ratio
                snapshot = {
                    "comparison_key": comparison_key,
                    "collected_at": _iso(),
                    "monthly_searches": _volume(metric),
                    "volume_masked": metric.volume_masked if metric else False,
                    "latest_ratio": latest_ratio,
                    "latest_period": trend.points[-1].period if trend and trend.points else None,
                    "data_status": {"searchad": searchad_status, "trend": trend_status},
                }
                row.previous_snapshot = row.last_snapshot
                row.last_snapshot = snapshot
                row.comparison_key = comparison_key
                row.last_status = (
                    "ok"
                    if searchad_status == "ok" and trend_status == "ok"
                    else "partial"
                    if "ok" in {searchad_status, trend_status}
                    else "unavailable"
                )
                session.flush()
                updated.append(self._watchlist_view(session, row))
            session.commit()
        return {
            "items": updated,
            "requested": len(unique_ids),
            "estimated_calls": len(unique_ids) * 2,
            "automatic_refresh": False,
        }

    def ad_performance(
        self, since: str, until: str, *, force_refresh: bool = False
    ) -> dict:
        if self._searchad is None:
            return {"status": "unconfigured", "read_only": True, "rows": [], "recommendations": []}
        campaigns, campaign_status = self._safe(
            lambda: self._searchad.list_campaigns(force_refresh=force_refresh)
        )
        adgroups, adgroup_status = self._safe(
            lambda: self._searchad.list_adgroups(force_refresh=force_refresh)
        )
        keyword_rows: list[dict] = []
        keyword_statuses: list[str] = []
        for adgroup in (adgroups or [])[:ACCOUNT_ADGROUP_CAP]:
            adgroup_id = str(adgroup.get("nccAdgroupId", ""))
            if not adgroup_id:
                continue
            rows, status = self._safe(
                lambda adgroup_id=adgroup_id: self._searchad.list_keywords(
                    adgroup_id, force_refresh=force_refresh
                )
            )
            keyword_statuses.append(status)
            for row in rows or []:
                row = dict(row)
                row["nccAdgroupId"] = row.get("nccAdgroupId") or adgroup_id
                keyword_rows.append(row)
                if len(keyword_rows) >= ACCOUNT_KEYWORD_CAP:
                    break
            if len(keyword_rows) >= ACCOUNT_KEYWORD_CAP:
                break
        ids = [str(row.get("nccKeywordId", "")) for row in keyword_rows if row.get("nccKeywordId")]
        stats_rows: list[dict] = []
        stats_statuses: list[str] = []
        for start in range(0, len(ids), 100):
            rows, status = self._safe(
                lambda chunk=ids[start : start + 100]: self._searchad.get_stats(
                    chunk, since, until, force_refresh=force_refresh
                )
            )
            stats_statuses.append(status)
            stats_rows.extend(rows or [])
        stats_by_id = {str(row.get("id", "")): row for row in stats_rows}

        local_content: dict[str, dict] = {}
        with self._sessions() as session:
            local_rows = session.execute(
                select(Keyword.text, func.count(Draft.id), func.max(Draft.created_at))
                .outerjoin(Draft, Draft.keyword_id == Keyword.id)
                .group_by(Keyword.id)
            ).all()
            for text, count, last_draft_at in local_rows:
                state = "missing" if not count else "covered"
                if last_draft_at and (datetime.now(timezone.utc).replace(tzinfo=None) - last_draft_at.replace(tzinfo=None)).days > 90:
                    state = "stale"
                local_content[_metric_key(text)] = {
                    "state": state,
                    "draft_count": count,
                    "last_draft_at": _iso(last_draft_at) if last_draft_at else None,
                }

        rows = []
        for keyword_row in keyword_rows:
            keyword_id = str(keyword_row.get("nccKeywordId", ""))
            keyword = str(keyword_row.get("keyword", ""))
            stat = stats_by_id.get(keyword_id, {})
            content = local_content.get(
                _metric_key(keyword), {"state": "missing", "draft_count": 0, "last_draft_at": None}
            )
            item = {
                "id": keyword_id,
                "keyword": keyword,
                "campaign_id": keyword_row.get("nccCampaignId"),
                "adgroup_id": keyword_row.get("nccAdgroupId"),
                "impressions": _number(stat, "impCnt"),
                "clicks": _number(stat, "clkCnt"),
                "ctr": _number(stat, "ctr"),
                "cpc": _number(stat, "cpc"),
                "cost": _number(stat, "salesAmt"),
                "conversions": _number(stat, "ccnt"),
                "conversion_value": _number(stat, "convAmt"),
                "roas": _number(stat, "ror"),
                "content": content,
            }
            rows.append(item)
        clicked = sorted(float(row["clicks"] or 0) for row in rows if (row["clicks"] or 0) > 0)
        high_performance_threshold = (
            clicked[min(len(clicked) - 1, math.floor(len(clicked) * 0.75))] if clicked else None
        )
        recommendations = [
            {
                "keyword": row["keyword"],
                "reason": "계정 내 클릭 상위권이나 로컬 콘텐츠가 없거나 90일 이상 경과",
                "content_state": row["content"]["state"],
                "clicks": row["clicks"],
                "conversions": row["conversions"],
            }
            for row in rows
            if high_performance_threshold is not None
            and float(row["clicks"] or 0) >= high_performance_threshold
            and row["content"]["state"] in {"missing", "stale"}
        ]
        recommendations.sort(key=lambda row: row["clicks"] or 0, reverse=True)
        statuses = {
            "campaigns": campaign_status,
            "adgroups": adgroup_status,
            "keywords": "ok" if keyword_statuses and all(value == "ok" for value in keyword_statuses) else "partial" if keyword_statuses else "empty",
            "stats": "ok" if stats_statuses and all(value == "ok" for value in stats_statuses) else "partial" if stats_statuses else "empty",
        }
        return {
            "status": "empty" if not keyword_rows else "ok" if all(value == "ok" for value in statuses.values()) else "partial",
            "read_only": True,
            "period": {"since": since, "until": until},
            "data_status": statuses,
            "campaign_count": len(campaigns or []),
            "adgroup_count": len(adgroups or []),
            "rows": rows,
            "recommendations": recommendations,
            "high_performance_click_threshold": high_performance_threshold,
            "caps": {"adgroups": ACCOUNT_ADGROUP_CAP, "keywords": ACCOUNT_KEYWORD_CAP},
            "collected_at": _iso(),
        }
