"""Explicit live reads for research modes; no operating DB or browser writes.

Run with: uv run pytest -m smoke tests/smoke/test_research_modes.py
Real provider quota is consumed. Image results are metadata only, not licensed
assets; these tests never download or approve an image for publication.
"""

from datetime import date, timedelta

import pytest

from app.config import get_settings
from providers.gateway import ProviderPolicy
from providers.naver_hub.client import NaverHubSearchClient, NaverHubShoppingClient
from tests.conftest import make_gateway

pytestmark = pytest.mark.smoke


@pytest.fixture(scope="module")
def hub_clients():
    value = get_settings()
    if not value.hub_configured:
        pytest.skip("NAVER API HUB credentials not configured")
    # Do not pass Settings into test arguments: pytest renders their repr on
    # failure, which would expose credential values in a traceback.
    return (
        NaverHubSearchClient(
            make_gateway(), value.naver_hub_client_id, value.naver_hub_client_secret,
            search_policy=ProviderPolicy("hub_research_mode_smoke", 100),
        ),
        NaverHubShoppingClient(
            make_gateway(), value.naver_hub_client_id, value.naver_hub_client_secret,
            shopping_policy=ProviderPolicy("hub_shopping_smoke", 100),
        ),
    )


@pytest.mark.parametrize(
    ("method", "query", "required_field"),
    [
        ("search_local", "서울 카페", "address"),
        ("search_images", "제주도 풍경", "thumbnail"),
        ("search_news_latest", "여행", "published_at"),
    ],
    ids=["local", "image-metadata", "latest-news"],
)
def test_research_search_mode_live(hub_clients, method, query, required_field):
    client = hub_clients[0]
    result = getattr(client, method)(query, display=1)
    assert result["from_cache"] is False
    assert result["collected_at"]
    assert result["items"], "live search returned no sample to validate"
    assert result["items"][0]["title"]
    assert result["items"][0][required_field]


def test_shopping_keyword_trend_live(hub_clients):
    client = hub_clients[1]
    end = date.today() - timedelta(days=1)
    rows = client.get_keyword_trends(
        "50000000", ["티셔츠"], time_unit="date",
        start_date=end - timedelta(days=13), end_date=end,
    )
    assert rows and rows[0]["points"], "shopping trend returned no sample to validate"
    assert rows[0]["from_cache"] is False
    assert rows[0]["collected_at"]
    assert all(0 <= point["ratio"] <= 100 for point in rows[0]["points"])
