"""Live API HUB smoke tests. Run explicitly: uv run pytest -m smoke tests/smoke"""

import pytest

from app.config import get_settings
from providers.gateway import ProviderPolicy
from providers.naver_hub.client import NaverHubSearchClient, NaverHubTrendClient
from tests.conftest import make_gateway

pytestmark = pytest.mark.smoke


@pytest.fixture(scope="module")
def settings():
    s = get_settings()
    if not s.hub_configured:
        pytest.skip("NAVER API HUB credentials not configured")
    return s


def test_blog_search_live(settings):
    client = NaverHubSearchClient(
        make_gateway(), settings.naver_hub_client_id, settings.naver_hub_client_secret,
        search_policy=ProviderPolicy("hub_search_smoke", 100),
    )
    result = client.search("blog", "테스트")
    assert isinstance(result.total, int) and result.total > 0
    assert result.items and result.items[0].title


def test_trend_live(settings):
    client = NaverHubTrendClient(
        make_gateway(), settings.naver_hub_client_id, settings.naver_hub_client_secret,
        trend_policy=ProviderPolicy("hub_trend_smoke", 100),
    )
    series = client.get_search_trend("테스트")
    assert series.points, "trend must return ratio points"
    assert max(p.ratio for p in series.points) <= 100.0
