"""P0 gate: verify NAVER API HUB credentials with minimal live calls.

Prints status codes and top-level schema only — never credentials or full bodies.
Usage:
    uv run python scripts/verify_api_hub.py            # blog + trend
    uv run python scripts/verify_api_hub.py --all      # + cafe/kin/web/news/errata path check
    uv run python scripts/verify_api_hub.py --research # + adult/local/image/shopping live checks
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "local-core"))
from app.config import get_settings  # noqa: E402

BASE = "https://naverapihub.apigw.ntruss.com"
FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"

SEARCH_PATHS = {
    "blog": "/search/v1/blog",
    "cafe": "/search/v1/cafearticle",
    "kin": "/search/v1/kin",
    "web": "/search/v1/webkr",
    "news": "/search/v1/news",
    "errata": "/search/v1/errata",
    "adult": "/search/v1/adult",
    "local": "/search/v1/local",
    "image": "/search/v1/image",
}


def sanitize_search_items(items: list[dict]) -> list[dict]:
    out = []
    for i, item in enumerate(items[:2]):
        clean = dict(item)
        for field in ("link", "bloggerlink", "cafeurl", "originallink"):
            if field in clean:
                clean[field] = f"https://example.invalid/{field}/{i}"
        for field in ("bloggername", "cafename"):
            if field in clean:
                clean[field] = f"masked-{field}-{i}"
        out.append(clean)
    return out


def main() -> int:
    settings = get_settings()
    if not settings.hub_configured:
        print("BLOCKED: NAVER_HUB_CLIENT_ID / NAVER_HUB_CLIENT_SECRET not set in .env")
        return 2

    headers = {
        "X-NCP-APIGW-API-KEY-ID": settings.naver_hub_client_id,
        "X-NCP-APIGW-API-KEY": settings.naver_hub_client_secret,
    }
    check_all = "--all" in sys.argv
    check_research = "--research" in sys.argv
    failures = 0
    FIXTURES.mkdir(parents=True, exist_ok=True)

    with httpx.Client(base_url=BASE, headers=headers, timeout=15) as client:
        if check_research:
            names = ["blog", "errata", "adult", "local", "image"]
        elif check_all:
            names = ["blog", "cafe", "kin", "web", "news", "errata"]
        else:
            names = ["blog"]
        paths = {name: SEARCH_PATHS[name] for name in names}
        for name, path in paths.items():
            params = {"query": "테스트"}
            if name == "local":
                params.update({"display": 5, "start": 1, "sort": "comment"})
            elif name == "image":
                params.update({"display": 10, "start": 1, "sort": "sim", "filter": "all"})
            elif name not in {"errata", "adult"}:
                params.update({"display": 10, "start": 1})
            r = client.get(path, params=params)
            # HUB search replies with JSON bodies labeled text/plain — never trust content-type.
            try:
                body = r.json()
            except ValueError:
                body = {}
            ok = r.status_code == 200 and (
                "total" in body or "items" in body or "errata" in body or body.get("adult") in {"0", "1"}
            )
            print(f"search/{name:7s} {path:28s} -> {r.status_code} "
                  f"total={'Y' if 'total' in body else '-'} items={'Y' if 'items' in body else '-'} "
                  f"{'OK' if ok else 'FAIL keys=' + ','.join(sorted(body)[:6])}")
            if not ok:
                failures += 1
            elif name == "blog":
                fixture = {"total": body.get("total"), "start": body.get("start"),
                           "display": body.get("display"), "items": sanitize_search_items(body.get("items", []))}
                (FIXTURES / "hub_blog_search.json").write_text(
                    json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")

        today = dt.date.today()
        trend_body = {
            "startDate": (today - dt.timedelta(days=365)).strftime("%Y-%m-01"),
            "endDate": today.strftime("%Y-%m-%d"),
            "timeUnit": "month",
            "keywordGroups": [{"groupName": "테스트", "keywords": ["테스트"]}],
        }
        r = client.post("/search-trend/v1/search", json=trend_body)
        body = r.json() if r.status_code == 200 else {}
        results = body.get("results", [])
        has_ratio = bool(results and results[0].get("data") and "ratio" in results[0]["data"][0])
        print(f"trend           /search-trend/v1/search   -> {r.status_code} ratio={'Y' if has_ratio else 'N'} "
              f"{'OK' if r.status_code == 200 and has_ratio else 'FAIL'}")
        if r.status_code == 200 and has_ratio:
            (FIXTURES / "hub_search_trend.json").write_text(
                json.dumps(body, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            failures += 1

        if check_research:
            shopping_body = {
                "startDate": (today - dt.timedelta(days=365)).strftime("%Y-%m-01"),
                "endDate": today.strftime("%Y-%m-%d"),
                "timeUnit": "month",
                "category": "50000000",
                "keyword": [{"name": "러닝화", "param": ["러닝화"]}],
            }
            r = client.post("/shopping/v1/category/keywords", json=shopping_body)
            body = r.json() if r.status_code == 200 else {}
            rows = body.get("results", [])
            has_ratio = bool(rows and rows[0].get("data") and "ratio" in rows[0]["data"][0])
            ok = r.status_code == 200 and has_ratio
            print(f"shopping         /shopping/v1/category/keywords -> {r.status_code} ratio={'Y' if has_ratio else 'N'} {'OK' if ok else 'FAIL'}")
            if not ok:
                failures += 1

    print("RESULT:", "PASS" if failures == 0 else f"FAIL ({failures})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
