"""Related-keyword clustering.

Korean related keywords come back space-less ("애드포스트승인조건"), so token overlap
is useless — character-bigram Jaccard works instead. Greedy assignment ordered by
volume keeps the result deterministic for a given snapshot.
"""

from __future__ import annotations

from intelligence.keyword.models import compact
from providers.models import KeywordMetric


def bigrams(text: str) -> set[str]:
    normalized = compact(text)
    if len(normalized) < 2:
        return {normalized} if normalized else set()
    return {normalized[i : i + 2] for i in range(len(normalized) - 1)}


def similarity(a: str, b: str) -> float:
    ga, gb = bigrams(a), bigrams(b)
    if not ga or not gb:
        return 0.0
    return len(ga & gb) / len(ga | gb)


def cluster_keywords(metrics: list[KeywordMetric], threshold: float = 0.4) -> list[dict]:
    ordered = sorted(metrics, key=lambda m: (-(m.monthly_total_searches or 0), m.keyword))
    clusters: list[dict] = []
    for metric in ordered:
        if not metric.keyword:
            continue
        target = next(
            (c for c in clusters if similarity(c["label"], metric.keyword) >= threshold), None
        )
        if target is None:
            clusters.append(
                {
                    "label": metric.keyword,
                    "keywords": [metric.keyword],
                    "total_volume": metric.monthly_total_searches or 0,
                }
            )
        else:
            target["keywords"].append(metric.keyword)
            target["total_volume"] += metric.monthly_total_searches or 0
    return clusters
