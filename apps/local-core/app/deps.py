from __future__ import annotations

from functools import lru_cache

from app import errors
from app.config import get_settings
from app.db import make_engine, make_session_factory
from app.services.analyze import AnalyzeService
from app.services.drafts import DraftService
from app.services.factpacks import FactPackService
from app.services.intent import IntentBoardService
from app.services.work import TodayWorkService
from app.services.publishing import PublishService
from app.services.published import PublishedContentService
from app.services.research import ResearchService
from app.stores import SqlCacheStore, SqlUsageStore
from providers.gateway import Gateway, ProviderPolicy
from providers.naver_hub.client import (
    NaverHubSearchClient,
    NaverHubShoppingClient,
    NaverHubTrendClient,
)
from providers.searchad.client import NaverSearchAdClient
from providers.llm.base import LLMError
from providers.llm.factory import build_llm_provider


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
        transport_error=errors.UpstreamUnavailableError,
        schema_error=errors.SchemaError,
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
            search_policy=ProviderPolicy(
                "naver_hub_search",
                settings.hub_search_monthly_limit,
                daily_limit=settings.hub_search_daily_limit,
                requests_per_second=settings.hub_search_rps,
            ),
        )
        hub_trend = NaverHubTrendClient(
            gateway,
            settings.naver_hub_client_id,
            settings.naver_hub_client_secret,
            trend_policy=ProviderPolicy(
                "naver_hub_trend",
                settings.hub_trend_monthly_limit,
                daily_limit=settings.hub_trend_daily_limit,
                requests_per_second=settings.hub_trend_rps,
            ),
        )
    if settings.searchad_configured:
        searchad = NaverSearchAdClient(
            gateway,
            settings.naver_searchad_api_key,
            settings.naver_searchad_secret_key,
            settings.naver_searchad_customer_id,
            policy=ProviderPolicy(
                "searchad",
                settings.searchad_monthly_limit,
                daily_limit=settings.searchad_daily_limit,
                requests_per_second=settings.searchad_rps,
                max_concurrency=1,
            ),
        )

    return AnalyzeService(get_session_factory(), searchad, hub_search, hub_trend)


@lru_cache
def get_research_service() -> ResearchService:
    settings = get_settings()
    gateway = get_gateway()
    hub_search = hub_trend = hub_shopping = searchad = None
    if settings.hub_configured:
        hub_search = NaverHubSearchClient(
            gateway,
            settings.naver_hub_client_id,
            settings.naver_hub_client_secret,
            search_policy=ProviderPolicy(
                "naver_hub_search",
                settings.hub_search_monthly_limit,
                daily_limit=settings.hub_search_daily_limit,
                requests_per_second=settings.hub_search_rps,
            ),
        )
        hub_trend = NaverHubTrendClient(
            gateway,
            settings.naver_hub_client_id,
            settings.naver_hub_client_secret,
            trend_policy=ProviderPolicy(
                "naver_hub_trend",
                settings.hub_trend_monthly_limit,
                daily_limit=settings.hub_trend_daily_limit,
                requests_per_second=settings.hub_trend_rps,
            ),
        )
        hub_shopping = NaverHubShoppingClient(
            gateway,
            settings.naver_hub_client_id,
            settings.naver_hub_client_secret,
            shopping_policy=ProviderPolicy(
                "naver_hub_shopping",
                settings.hub_shopping_monthly_limit,
                daily_limit=settings.hub_shopping_daily_limit,
                requests_per_second=settings.hub_shopping_rps,
            ),
        )
    if settings.searchad_configured:
        searchad = NaverSearchAdClient(
            gateway,
            settings.naver_searchad_api_key,
            settings.naver_searchad_secret_key,
            settings.naver_searchad_customer_id,
            policy=ProviderPolicy(
                "searchad",
                settings.searchad_monthly_limit,
                daily_limit=settings.searchad_daily_limit,
                requests_per_second=settings.searchad_rps,
                max_concurrency=1,
            ),
        )
    return ResearchService(
        get_session_factory(), searchad, hub_search, hub_trend, hub_shopping
    )


@lru_cache
def get_draft_service(use_llm: bool = False) -> DraftService:
    settings = get_settings()
    llm = None
    if use_llm:
        # local -> Ollama, openai_compat -> Codex OAuth proxy 등 OpenAI 호환 엔드포인트.
        # 미지원 값·프록시 자동 기동 실패는 표준 llm_unavailable 오류로 변환된다.
        try:
            llm = build_llm_provider(settings)
        except LLMError as exc:
            configured = settings.llm_provider or "llm"
            provider = "ollama" if configured == "local" else configured
            raise errors.LLMUnavailableError(str(exc), provider=provider) from exc
    return DraftService(get_session_factory(), llm)


@lru_cache
def get_publish_service() -> PublishService:
    return PublishService(get_session_factory())


@lru_cache
def get_published_content_service() -> PublishedContentService:
    return PublishedContentService(get_session_factory())


@lru_cache
def get_fact_pack_service() -> FactPackService:
    return FactPackService(get_session_factory())


@lru_cache
def get_intent_board_service() -> IntentBoardService:
    return IntentBoardService(get_session_factory())


@lru_cache
def get_today_work_service() -> TodayWorkService:
    return TodayWorkService(get_session_factory())


def reset_caches() -> None:
    """Test helper: drop every cached singleton (settings included)."""
    get_settings.cache_clear()
    get_session_factory.cache_clear()
    get_gateway.cache_clear()
    get_analyze_service.cache_clear()
    get_research_service.cache_clear()
    get_draft_service.cache_clear()
    get_publish_service.cache_clear()
    get_published_content_service.cache_clear()
    get_fact_pack_service.cache_clear()
    get_intent_board_service.cache_clear()
    get_today_work_service.cache_clear()
