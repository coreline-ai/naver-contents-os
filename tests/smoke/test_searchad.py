"""Live SearchAd smoke test. Run explicitly: uv run pytest -m smoke tests/smoke"""

import pytest

from app.config import get_settings
from providers.gateway import ProviderPolicy
from providers.searchad.client import NaverSearchAdClient
from tests.conftest import make_gateway

pytestmark = pytest.mark.smoke


def test_keywordstool_live():
    settings = get_settings()
    if not settings.searchad_configured:
        pytest.skip("SearchAd credentials not configured")

    client = NaverSearchAdClient(
        make_gateway(),
        settings.naver_searchad_api_key,
        settings.naver_searchad_secret_key,
        settings.naver_searchad_customer_id,
        policy=ProviderPolicy("searchad_smoke", 100, max_concurrency=1),
    )
    rows = client.get_related_keywords("애드포스트")
    assert rows, "keywordList must not be empty"
    first = rows[0]
    assert first.keyword
    assert first.volume_masked or first.monthly_total_searches is not None
