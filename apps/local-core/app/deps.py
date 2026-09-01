from __future__ import annotations

from functools import lru_cache

from app import errors
from app.config import get_settings
from app.db import make_engine, make_session_factory
from app.services.analyze import AnalyzeService
from app.stores import SqlCacheStore, SqlUsageStore
from providers.gateway import Gateway, ProviderPolicy
from providers.naver_hub.client import NaverHubSearchClient, NaverHubTrendClient
from providers.searchad.client import NaverSearchAdClient


@lru_cache
def get_session_factory():
    return make_session_factory(make_engine(get_settings().db_path))


@lru_cache
def get_gateway() -> Gateway:
    sessions = get_session_factory()
    return Gateway(
        cache=SqlCacheStore(sessions),
        usage=SqlUsageStore(sessions),
        auth_error=errors.AuthError,
        request_error=errors.RequestError,
        rate_limit_error=errors.RateLimitError,
        quota_error=errors.QuotaError,
        warn_ratio=get_settings().usage_warn_ratio,
    )


@lru_cache
def get_analyze_service() -> AnalyzeService:
    settings = get_settings()
    gateway = get_gateway()

    hub_search = hub_trend = searchad = None
    if settings.hub_configured:
        hub_search = NaverHubSearchClient(
            gateway,
            settings.naver_hub_client_id,
            settings.naver_hub_client_secret,
            search_policy=ProviderPolicy("naver_hub_search", settings.hub_search_monthly_limit),
        )
        hub_trend = NaverHubTrendClient(
            gateway,
            settings.naver_hub_client_id,
            settings.naver_hub_client_secret,
            trend_policy=ProviderPolicy("naver_hub_trend", settings.hub_trend_monthly_limit),
        )
    if settings.searchad_configured:
        searchad = NaverSearchAdClient(
            gateway,
            settings.naver_searchad_api_key,
            settings.naver_searchad_secret_key,
            settings.naver_searchad_customer_id,
            policy=ProviderPolicy("searchad", settings.searchad_monthly_limit, max_concurrency=1),
        )

    return AnalyzeService(get_session_factory(), searchad, hub_search, hub_trend)


def reset_caches() -> None:
    """Test helper: drop every cached singleton (settings included)."""
    get_settings.cache_clear()
    get_session_factory.cache_clear()
    get_gateway.cache_clear()
    get_analyze_service.cache_clear()
