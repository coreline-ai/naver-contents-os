"""P0 gate: verify SearchAd credentials with one /keywordstool call.

Prints status and schema only — never credentials, signatures, or headers.
Usage: uv run python scripts/verify_searchad.py [hintKeyword]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "local-core"))
sys.path.insert(0, str(ROOT / "python"))
from app.config import get_settings  # noqa: E402
from providers.searchad.signature import auth_headers  # noqa: E402

BASE = "https://api.searchad.naver.com"
URI = "/keywordstool"
FIXTURES = ROOT / "tests" / "fixtures"

KEEP_FIELDS = (
    "relKeyword", "monthlyPcQcCnt", "monthlyMobileQcCnt", "monthlyAvePcClkCnt",
    "monthlyAveMobileClkCnt", "monthlyAvePcCtr", "monthlyAveMobileCtr", "plAvgDepth", "compIdx",
)


def main() -> int:
    settings = get_settings()
    if not settings.searchad_configured:
        print("BLOCKED: NAVER_SEARCHAD_API_KEY / SECRET_KEY / CUSTOMER_ID not set in .env")
        return 2

    hint = sys.argv[1] if len(sys.argv) > 1 else "애드포스트"
    headers = auth_headers(
        "GET", URI,
        settings.naver_searchad_api_key,
        settings.naver_searchad_secret_key,
        settings.naver_searchad_customer_id,
    )
    with httpx.Client(base_url=BASE, timeout=15) as client:
        r = client.get(URI, params={"hintKeywords": hint, "showDetail": 1}, headers=headers)

    if r.status_code != 200:
        print(f"keywordstool -> {r.status_code} FAIL (check signature/credentials; body keys only): "
              f"{sorted(r.json())[:5] if r.headers.get('content-type','').startswith('application/json') else 'non-json'}")
        return 1

    body = r.json()
    kw_list = body.get("keywordList", [])
    first = kw_list[0] if kw_list else {}
    print(f"keywordstool -> 200 keywordList={len(kw_list)} "
          f"pc={'Y' if 'monthlyPcQcCnt' in first else 'N'} mobile={'Y' if 'monthlyMobileQcCnt' in first else 'N'} OK")

    FIXTURES.mkdir(parents=True, exist_ok=True)
    fixture = {"keywordList": [{k: item.get(k) for k in KEEP_FIELDS} for item in kw_list[:3]]}
    (FIXTURES / "searchad_keywordstool.json").write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
