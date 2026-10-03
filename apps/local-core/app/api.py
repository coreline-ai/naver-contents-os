from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app import deps, errors
from app.auth import require_token
from app.services.analyze import AnalyzeService
from app.services.composer import BlogComposerService
from app.services.drafts import DraftService
from app.services.draft_assets import DraftAssetService
from app.services.factpacks import FactPackService
from app.services.intent import IntentBoardService
from app.services.work import TodayWorkService
from app.services.publishing import PublishPreconditionError, PublishService
from app.services.published import PublishedContentService
from app.services.performance import PerformanceService
from app.services.research import ResearchService
from intelligence.keyword.models import compact, normalize_keyword
from planner.templates import is_active
from planner.types import BlogType
from providers.llm.base import LLMError
from providers.models import SerpObservation

router = APIRouter(prefix="/v1", dependencies=[Depends(require_token)])


def get_analyze_service() -> AnalyzeService:
    return deps.get_analyze_service()


def get_draft_service_factory() -> Callable[[bool], DraftService]:
    return deps.get_draft_service


def get_draft_asset_service() -> DraftAssetService:
    return deps.get_draft_asset_service()


def get_publish_service() -> PublishService:
    return deps.get_publish_service()


def get_research_service() -> ResearchService:
    return deps.get_research_service()


def get_published_content_service() -> PublishedContentService:
    return deps.get_published_content_service()


def get_fact_pack_service() -> FactPackService:
    return deps.get_fact_pack_service()


def get_intent_board_service() -> IntentBoardService:
    return deps.get_intent_board_service()


def get_today_work_service() -> TodayWorkService:
    return deps.get_today_work_service()


def get_blog_composer_service() -> BlogComposerService:
    return deps.get_blog_composer_service()


def get_performance_service() -> PerformanceService:
    return deps.get_performance_service()


@router.get("/handshake")
def handshake() -> dict:
    return {"status": "ok"}


class AnalyzeRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)
    force_refresh: bool = False
    serp: SerpObservation | None = None

    @field_validator("keyword")
    @classmethod
    def normalize_and_validate_keyword(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not normalized:
            raise ValueError("keyword must contain non-whitespace characters")
        return normalized

    @model_validator(mode="after")
    def validate_serp_query(self):
        if self.serp is not None and compact(self.serp.query) != compact(self.keyword):
            raise ValueError("serp.query must match keyword")
        return self


@router.post("/keywords/analyze")
def analyze_keyword(
    request: AnalyzeRequest,
    service: AnalyzeService = Depends(get_analyze_service),
) -> dict:
    return service.analyze(request.keyword, force_refresh=request.force_refresh, serp=request.serp)


class KeywordResearchRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)
    force_refresh: bool = False

    @field_validator("keyword")
    @classmethod
    def normalize_research_keyword(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not normalized:
            raise ValueError("keyword must contain non-whitespace characters")
        return normalized


class GraphRequest(KeywordResearchRequest):
    snapshot_id: int | None = Field(default=None, ge=1)


def _valid_suggestion_length(value: str) -> bool:
    compact_value = "".join(value.split())
    has_cjk = any("\u2e80" <= char <= "\ud7af" for char in compact_value)
    return len(compact_value) >= (2 if has_cjk else 3)


class SuggestRequest(BaseModel):
    query: str = Field(min_length=1, max_length=100)
    limit: int = Field(default=8, ge=1, le=8)

    @field_validator("query")
    @classmethod
    def normalize_suggest_query(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not _valid_suggestion_length(normalized):
            raise ValueError("query must contain 2 CJK characters or 3 other characters")
        return normalized


class RisingRequest(BaseModel):
    seed: str = Field(default="", max_length=100)
    mode: Literal["general", "local", "shopping", "news"] = "general"
    region: str = Field(default="", max_length=100)
    category: str = Field(default="", max_length=30)
    candidate_limit: int = Field(default=20, ge=1, le=20)
    force_refresh: bool = False

    @field_validator("seed", "region")
    @classmethod
    def normalize_rising_text(cls, value: str) -> str:
        return normalize_keyword(value)

    @field_validator("category")
    @classmethod
    def normalize_category(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_mode_inputs(self):
        if self.mode in {"general", "shopping", "news"} and not self.seed:
            raise ValueError("seed is required for this mode")
        if self.mode == "local" and not self.region:
            raise ValueError("region is required for local mode")
        if self.mode == "shopping" and not self.category:
            raise ValueError("category is required for shopping mode")
        return self


class CommercialRequest(BaseModel):
    keywords: list[Annotated[str, Field(min_length=1, max_length=100)]] = Field(
        min_length=1, max_length=20
    )
    device: Literal["PC", "MOBILE"] = "PC"
    force_refresh: bool = False


class SpecializedRequest(KeywordResearchRequest):
    mode: Literal["general", "local", "shopping", "image"] = "general"
    category: str = Field(default="", max_length=30)

    @model_validator(mode="after")
    def require_shopping_category(self):
        if self.mode == "shopping" and not self.category.strip():
            raise ValueError("category is required for shopping mode")
        return self


class WatchlistCreateRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)

    @field_validator("keyword")
    @classmethod
    def normalize_watch_keyword(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not normalized:
            raise ValueError("keyword must contain non-whitespace characters")
        return normalized


class WatchlistRefreshRequest(BaseModel):
    item_ids: list[Annotated[int, Field(ge=1)]] = Field(min_length=1, max_length=50)
    force_refresh: bool = False


class AdPerformanceRequest(BaseModel):
    since: date
    until: date
    force_refresh: bool = False

    @model_validator(mode="after")
    def validate_period(self):
        if self.since > self.until:
            raise ValueError("since must not be after until")
        if (self.until - self.since).days > 365:
            raise ValueError("performance period must be 365 days or less")
        return self


class TodayWorkItemResponse(BaseModel):
    id: str
    priority: int
    source_type: str
    source_id: int
    keyword: str
    title: str
    reason: str
    action: Literal[
        "inspect_error", "resume_draft", "register_publication", "refresh_data", "open_analysis",
        "open_performance",
    ]
    stale: bool
    draft_id: int | None
    publish_job_id: int | None
    published_content_id: int | None
    published_url: str | None
    calculated_at: str


class TodayWorkResponse(BaseModel):
    items: list[TodayWorkItemResponse]
    calculated_at: str
    limit: int


class PerformanceChannelCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["creator_advisor", "biz_advisor", "search_advisor"]
    display_name: str = Field(min_length=1, max_length=100)
    site_url: str | None = Field(default=None, max_length=1000)
    ownership_confirmed: bool = False

    @field_validator("display_name")
    @classmethod
    def normalize_channel_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("display_name is required")
        return normalized


class PerformanceChannelUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


_PERFORMANCE_ROW_FIELDS = {
    "content_performance": {
        "canonical_url", "published_content_id", "title", "views", "impressions",
        "inflows", "ctr", "average_rank", "likes", "comments", "data_state",
    },
    "query_performance": {
        "query", "canonical_url", "published_content_id", "impressions", "inflows",
        "ctr", "average_rank", "data_state",
    },
    "commerce_attribution": {
        "tracking_id", "destination_url", "published_content_id", "inflows",
        "product_views", "orders", "conversion_rate", "attributed_revenue", "data_state",
    },
    "site_performance": {
        "page_url", "collected_pages", "indexed_pages", "impressions", "clicks", "ctr",
        "data_state",
    },
}


class PerformanceImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel_id: int = Field(ge=1)
    source: Literal["creator_advisor", "biz_advisor", "search_advisor"]
    data_kind: Literal[
        "content_performance", "query_performance", "commerce_attribution", "site_performance"
    ]
    period_start: date
    period_end: date
    grain: Literal["daily", "weekly", "monthly"]
    rows: list[dict[str, object | None]] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def validate_rows_and_source(self):
        expected = {
            "content_performance": "creator_advisor",
            "query_performance": "creator_advisor",
            "commerce_attribution": "biz_advisor",
            "site_performance": "search_advisor",
        }[self.data_kind]
        if self.source != expected:
            raise ValueError("data_kind does not belong to source")
        if self.period_start > self.period_end:
            raise ValueError("period_start must not be after period_end")
        allowed = _PERFORMANCE_ROW_FIELDS[self.data_kind]
        for index, row in enumerate(self.rows, start=1):
            extras = sorted(set(row) - allowed)
            if extras:
                raise ValueError(f"row {index} contains unsupported fields: {', '.join(extras)}")
        return self


class PerformanceMappingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    published_content_id: int = Field(ge=1)


class PerformanceRecommendationStatusRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["open", "dismissed", "done"]


class TrackingLinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    destination_url: str = Field(min_length=1, max_length=1000)
    nt_source: str = Field(min_length=1, max_length=100)
    nt_medium: str = Field(min_length=1, max_length=100)
    nt_detail: str = Field(default="", max_length=100)
    nt_keyword: str = Field(default="", max_length=100)
    published_content_id: int | None = Field(default=None, ge=1)


@router.get("/capabilities")
def get_capabilities(service: ResearchService = Depends(get_research_service)) -> dict:
    return service.capabilities()


@router.get("/work/today", response_model=TodayWorkResponse)
def get_today_work(
    limit: int = Query(default=5, ge=1, le=5),
    service: TodayWorkService = Depends(get_today_work_service),
) -> dict:
    return service.list(limit=limit)


@router.get("/performance/metric-dictionary")
def get_performance_metric_dictionary(
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    return service.metric_dictionary()


@router.post("/performance/channels", status_code=201)
def create_performance_channel(
    request: PerformanceChannelCreateRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.create_channel(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_performance_channel", "message": str(exc)},
        ) from exc


@router.get("/performance/channels")
def list_performance_channels(
    include_disabled: bool = True,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    return service.list_channels(include_disabled=include_disabled)


@router.patch("/performance/channels/{channel_id}")
def update_performance_channel(
    channel_id: int,
    request: PerformanceChannelUpdateRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    updated = service.update_channel(channel_id, enabled=request.enabled)
    if updated is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "channel not found"}
        )
    return updated


@router.post("/performance/imports/preview")
def preview_performance_import(
    request: PerformanceImportRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.preview_import(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_performance_import", "message": str(exc)},
        ) from exc


@router.post("/performance/imports", status_code=201)
def create_performance_import(
    request: PerformanceImportRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.create_import(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_performance_import", "message": str(exc)},
        ) from exc


@router.get("/performance/imports")
def list_performance_imports(
    channel_id: int | None = Query(default=None, ge=1),
    limit: int = Query(default=30, ge=1, le=100),
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    return service.list_imports(limit=limit, channel_id=channel_id)


@router.delete("/performance/imports/{import_id}", status_code=204)
def delete_performance_import(
    import_id: int,
    service: PerformanceService = Depends(get_performance_service),
) -> None:
    if not service.delete_import(import_id):
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "import not found"}
        )


@router.get("/performance/overview")
def get_performance_overview(
    import_id: int | None = Query(default=None, ge=1),
    channel_id: int | None = Query(default=None, ge=1),
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.overview(channel_id=channel_id, import_id=import_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": str(exc)}) from exc


@router.get("/performance/contents")
def list_content_performance(
    channel_id: int | None = Query(default=None, ge=1),
    import_id: int | None = Query(default=None, ge=1),
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.contents(import_id=import_id, channel_id=channel_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": str(exc)}
        ) from exc


@router.get("/performance/queries")
def list_query_performance(
    channel_id: int | None = Query(default=None, ge=1),
    import_id: int | None = Query(default=None, ge=1),
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.queries(import_id=import_id, channel_id=channel_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": str(exc)}
        ) from exc


@router.patch("/performance/content-snapshots/{snapshot_id}/mapping")
def map_content_performance_snapshot(
    snapshot_id: int,
    request: PerformanceMappingRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        updated = service.map_content_snapshot(snapshot_id, request.published_content_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_performance_mapping", "message": str(exc)},
        ) from exc
    if updated is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "snapshot not found"}
        )
    return updated


@router.get("/performance/recommendations")
def list_performance_recommendations(
    channel_id: int | None = Query(default=None, ge=1),
    status: Literal["open", "dismissed", "done"] = "open",
    limit: int = Query(default=50, ge=1, le=100),
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    return service.recommendations(status=status, limit=limit, channel_id=channel_id)


@router.patch("/performance/recommendations/{recommendation_id}")
def update_performance_recommendation(
    recommendation_id: int,
    request: PerformanceRecommendationStatusRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        updated = service.update_recommendation(recommendation_id, status=request.status)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_recommendation", "message": str(exc)},
        ) from exc
    if updated is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "recommendation not found"},
        )
    return updated


@router.post("/performance/tracking-links")
def build_performance_tracking_link(
    request: TrackingLinkRequest,
    service: PerformanceService = Depends(get_performance_service),
) -> dict:
    try:
        return service.build_tracking_link(**request.model_dump())
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_tracking_link", "message": str(exc)},
        ) from exc


@router.get("/snapshots/{snapshot_id}")
def get_snapshot(
    snapshot_id: int, service: ResearchService = Depends(get_research_service)
) -> dict:
    snapshot = service.snapshot(snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "snapshot not found"})
    return snapshot


@router.get("/snapshots/{snapshot_id}/intent-board")
def get_snapshot_intent_board(
    snapshot_id: int,
    service: IntentBoardService = Depends(get_intent_board_service),
) -> dict:
    board = service.get(snapshot_id)
    if board is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "snapshot not found"},
        )
    return board


@router.post("/keywords/preflight")
def preflight_keyword(
    request: KeywordResearchRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.preflight(request.keyword, force_refresh=request.force_refresh)


@router.post("/keywords/suggest")
def suggest_keywords(
    request: SuggestRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.suggest(request.query, limit=request.limit)


@router.post("/research/graph")
def build_keyword_graph(
    request: GraphRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.graph(
        request.keyword,
        snapshot_id=request.snapshot_id,
        force_refresh=request.force_refresh,
    )


@router.post("/research/rising")
def discover_rising_keywords(
    request: RisingRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.rising(
        seed=request.seed,
        mode=request.mode,
        region=request.region,
        category=request.category,
        candidate_limit=request.candidate_limit,
        force_refresh=request.force_refresh,
    )


@router.get("/research/rising/recent")
def get_recent_rising_keywords(
    limit: int = Query(default=8, ge=1, le=12),
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.recent_rising(limit=limit)


@router.get("/research/rising/latest")
def get_latest_rising_keywords(
    mode: Literal["general", "local", "shopping", "news"] = "general",
    seed: str = "",
    region: str = "",
    category: str = "",
    service: ResearchService = Depends(get_research_service),
) -> dict:
    normalized_seed = normalize_keyword(seed)
    normalized_region = normalize_keyword(region)
    if mode in {"general", "shopping", "news"} and not normalized_seed:
        raise HTTPException(status_code=422, detail={"code": "validation", "message": "seed is required for this mode"})
    if mode == "local" and not normalized_region:
        raise HTTPException(status_code=422, detail={"code": "validation", "message": "region is required for local mode"})
    if mode == "shopping" and not category.strip():
        raise HTTPException(status_code=422, detail={"code": "validation", "message": "category is required for shopping mode"})
    return service.latest_rising(
        seed=normalized_seed,
        mode=mode,
        region=normalized_region,
        category=category.strip(),
    )


@router.post("/research/commercial")
def analyze_commercial_intent(
    request: CommercialRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.commercial(
        request.keywords, device=request.device, force_refresh=request.force_refresh
    )


@router.post("/research/audience")
def analyze_audience(
    request: KeywordResearchRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.audience(request.keyword, force_refresh=request.force_refresh)


@router.post("/research/specialized")
def analyze_specialized(
    request: SpecializedRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.specialized(
        request.keyword,
        request.mode,
        category=request.category,
        force_refresh=request.force_refresh,
    )


@router.get("/watchlist")
def list_watchlist(service: ResearchService = Depends(get_research_service)) -> dict:
    return service.list_watchlist()


@router.post("/watchlist", status_code=201)
def add_watchlist(
    request: WatchlistCreateRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    try:
        return service.add_watchlist(request.keyword)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "watchlist_limit", "message": str(exc)}) from exc


@router.delete("/watchlist/{item_id}", status_code=204)
def delete_watchlist(
    item_id: int, service: ResearchService = Depends(get_research_service)
) -> None:
    if not service.delete_watchlist(item_id):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "watchlist item not found"})


@router.post("/watchlist/refresh")
def refresh_watchlist(
    request: WatchlistRefreshRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.refresh_watchlist(
        request.item_ids, force_refresh=request.force_refresh
    )


@router.post("/research/ad-performance")
def analyze_ad_performance(
    request: AdPerformanceRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.ad_performance(
        request.since.isoformat(),
        request.until.isoformat(),
        force_refresh=request.force_refresh,
    )


class PlanItemInput(BaseModel):
    order: int | None = Field(default=None, ge=1, le=100)
    title: str = Field(min_length=1, max_length=200)
    blog_type: BlogType
    target_keyword: str = Field(min_length=1, max_length=100)
    angle: str = Field(default="", max_length=300)
    reason: str = Field(default="", max_length=500)
    generation_status: Literal["ready", "structure_only"] | None = None
    series_prev: int | None = None
    series_next: int | None = None


class DraftCreateRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)
    snapshot_id: int | None = Field(default=None, ge=1)
    plan_item: PlanItemInput
    questions: list[str] = Field(default_factory=list, max_length=12)
    generation_mode: Literal["skeleton", "llm"] = "skeleton"
    fact_pack_id: int | None = Field(default=None, ge=1)
    fact_pack_version: int | None = Field(default=None, ge=1)

    @field_validator("keyword")
    @classmethod
    def normalize_draft_keyword(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not normalized:
            raise ValueError("keyword must contain non-whitespace characters")
        return normalized

    @model_validator(mode="after")
    def validate_generation_support(self):
        if (self.fact_pack_id is None) != (self.fact_pack_version is None):
            raise ValueError("fact_pack_id and fact_pack_version must be provided together")
        if self.generation_mode == "llm" and not is_active(self.plan_item.blog_type):
            raise ValueError(f"{self.plan_item.blog_type.value} is not enabled for LLM generation")
        return self


class DraftVersionCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=100_000)
    note: str = Field(default="", max_length=200)
    expected_version: int | None = Field(default=None, ge=1)


class DraftCreateResponse(BaseModel):
    draft_id: int
    version: int
    title: str
    body: str
    source_snapshot_id: int | None
    fact_pack_id: int | None
    fact_pack_version: int | None
    provider: str
    model: str
    prompt_version: str


class LLMStatusResponse(BaseModel):
    ready: bool
    provider: str
    model: str
    message: str
    action: str
    engine: str = "unknown"
    auth: str = "unknown"
    quality_tier: str = "unknown"


class BlogComposeRequest(BaseModel):
    keyword: str = Field(min_length=1, max_length=100)
    style: Literal["auto", "informational", "review", "product"] = "auto"
    user_notes: str = Field(default="", max_length=2_000)
    target_chars: int = Field(default=2_500, ge=1_800, le=5_000)
    allow_sensitive_unknown: bool = False
    force_refresh: bool = False
    source_draft_id: int | None = Field(default=None, ge=1)
    source_draft_mode: Literal["revision", "followup"] = "revision"

    @field_validator("keyword")
    @classmethod
    def normalize_compose_keyword(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not normalized:
            raise ValueError("keyword must contain non-whitespace characters")
        return normalized

    @field_validator("user_notes")
    @classmethod
    def trim_user_notes(cls, value: str) -> str:
        return value.strip()


class ArticleQualityResponse(BaseModel):
    passed: bool
    score: int
    char_count: int
    target_chars: int
    paragraph_count: int
    keyword_count: int
    issues: list[str]
    checks: dict[str, bool]
    repair_attempted: bool


class BlogComposeResponse(BaseModel):
    keyword: str
    snapshot_id: int
    draft: DraftCreateResponse
    quality: ArticleQualityResponse
    suggested_tags: list[str]
    analysis_summary: dict
    fact_pack_id: int | None
    fact_pack_version: int | None
    preflight: dict


class DraftVersionView(BaseModel):
    version: int
    title: str
    body: str
    note: str
    created_at: str | None = None


class DraftDetailResponse(BaseModel):
    draft_id: int
    keyword: str
    blog_type: str
    title: str
    source_snapshot_id: int | None
    user_status: Literal["editing", "review_ready", "archived"]
    fact_pack_id: int | None = None
    fact_pack_version: int | None = None
    created_at: str | None = None
    plan: dict
    provider: str
    model: str
    prompt_version: str
    versions: list[DraftVersionView]


class DraftVersionCreatedResponse(BaseModel):
    draft_id: int
    version: int


class DraftSummaryResponse(BaseModel):
    draft_id: int
    keyword: str
    title: str
    blog_type: str
    latest_version: int
    latest_version_at: str
    user_status: Literal["editing", "review_ready", "archived"]
    latest_job_status: Literal["none", "pending", "waiting_extension", "running", "draft_saved", "verified_draft_saved", "failed", "unknown"]
    latest_job_id: int | None
    latest_job_stage: str | None
    latest_job_error: str | None
    source_snapshot_id: int | None


class DraftListResponse(BaseModel):
    items: list[DraftSummaryResponse]
    next_cursor: str | None


class DraftStatusRequest(BaseModel):
    status: Literal["editing", "review_ready", "archived"]


class DraftStatusResponse(BaseModel):
    draft_id: int
    user_status: Literal["editing", "review_ready", "archived"]


class PublishedContentCreateRequest(BaseModel):
    draft_id: int | None = Field(default=None, ge=1)
    keyword: str = Field(default="", max_length=100)
    canonical_url: str = Field(min_length=1, max_length=1000)
    title: str = Field(min_length=1, max_length=200)
    published_at: datetime
    confirmed: bool = False

    @model_validator(mode="after")
    def require_source(self):
        if self.draft_id is None and not normalize_keyword(self.keyword):
            raise ValueError("draft_id or keyword is required")
        return self


class PublishedContentUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    published_at: datetime | None = None
    archived: bool | None = None

    @model_validator(mode="after")
    def require_change(self):
        if self.title is None and self.published_at is None and self.archived is None:
            raise ValueError("at least one published-content field is required")
        return self


class PublishedContentResponse(BaseModel):
    id: int
    draft_id: int | None
    keyword: str
    title: str
    canonical_url: str
    published_at: str
    verified_at: str
    archived_at: str | None
    state: Literal["published", "stale", "archived"]
    draft_count: int


class PublishedContentListResponse(BaseModel):
    items: list[PublishedContentResponse]


class FactPackCreateRequest(BaseModel):
    snapshot_id: int = Field(ge=1)
    draft_id: int | None = Field(default=None, ge=1)


class FactPackVersionCreateRequest(BaseModel):
    expected_version: int | None = Field(default=None, ge=1)
    selected_evidence_ids: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(
        default_factory=list, max_length=100
    )
    status: Literal["draft", "approved"] = "draft"


class FactPackEvidenceResponse(BaseModel):
    id: str
    kind: str
    label: str
    value: object
    source_type: str
    source_url: str | None
    source_id: str
    collected_at: str | None
    from_cache: bool
    freshness: Literal["fresh", "stale", "unknown"]
    selected: bool


class FactPackVersionResponse(BaseModel):
    version: int
    status: Literal["draft", "approved"]
    evidence: list[FactPackEvidenceResponse]
    warnings: list[str]
    created_at: str | None


class FactPackResponse(BaseModel):
    fact_pack_id: int
    snapshot_id: int
    draft_id: int | None
    keyword: str
    created_at: str | None
    latest_version: int
    latest_status: Literal["draft", "approved"]
    versions: list[FactPackVersionResponse]


class PublishJobCreateRequest(BaseModel):
    blog_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    tags: list[Annotated[str, Field(max_length=50)]] = Field(default_factory=list, max_length=10)
    expected_version: int | None = Field(default=None, ge=1)
    transport: Literal["dedicated_chrome_cdp", "current_chrome_extension"] = "dedicated_chrome_cdp"
    target_worker_id: str | None = Field(default=None, min_length=1, max_length=100)

    @field_validator("tags")
    @classmethod
    def normalize_tags(cls, values: list[str]) -> list[str]:
        return [value.strip() for value in values if value.strip()]


class PublishJobResponse(BaseModel):
    job_id: int
    draft_id: int
    status: str
    stage: str
    error_code: str | None
    detail: str
    history: list[dict]
    transport: str = "dedicated_chrome_cdp"
    draft_version: int = 1
    asset_manifest_version: int = 0
    verification: dict = Field(default_factory=dict)


class DraftAssetCreateRequest(BaseModel):
    draft_version: int = Field(ge=1)
    filename: str = Field(min_length=1, max_length=255)
    mime_type: Literal["image/png", "image/jpeg", "image/webp"]
    data_base64: str = Field(min_length=1, max_length=17_000_000)
    position: int = Field(ge=0, le=9)
    anchor_after: int = Field(default=0, ge=0, le=1000)
    rights_status: Literal["approved"]


class DraftAssetGenerateRequest(BaseModel):
    draft_version: int = Field(ge=1)
    count: int = Field(default=3, ge=1, le=3)


class DraftAssetResponse(BaseModel):
    asset_id: int
    draft_id: int
    draft_version: int
    filename: str
    mime_type: str
    byte_size: int
    sha256: str
    position: int
    anchor_after: int
    rights_status: str
    created_at: str | None


class PublishJobCommandResponse(BaseModel):
    attempt_id: str
    lease_owner: str
    resume_stage: Literal["browser_attach", "upload_images", "input_tags", "reopen_verify"]
    asset_manifest_hash: str
    image_receipts: list[dict] = Field(default_factory=list)
    job_id: int
    draft_id: int
    draft_version: int
    blog_id: str
    title: str
    body: str
    title_hash: str
    body_hash: str
    body_chars: int
    tags: list[str]
    assets: list[dict]


class PublishJobEventRequest(BaseModel):
    attempt_id: str = Field(min_length=1, max_length=100)
    lease_owner: str = Field(min_length=1, max_length=100)
    stage: Literal[
        "browser_attach", "health_check", "prepare_editor", "input_title", "input_body",
        "upload_images", "input_tags", "draft_save", "reopen_verify",
    ]
    status: Literal["running", "passed", "failed"]
    error_code: str | None = Field(default=None, max_length=80)
    detail: str = Field(default="", max_length=2000)
    verification: dict | None = None


class PublisherHeartbeatRequest(BaseModel):
    extension_id: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=40)
    active_url: str = Field(default="", max_length=1000)
    protocol_version: int = Field(default=0, ge=0, le=3)
    build_id: str = Field(default="", max_length=100)


@router.post("/drafts", status_code=201, response_model=DraftCreateResponse)
def create_draft(
    request: DraftCreateRequest,
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    service: DraftService | None = None
    try:
        service = service_factory(request.generation_mode == "llm")
        return service.create_draft(
            request.keyword,
            request.plan_item.model_dump(mode="json"),
            request.questions,
            snapshot_id=request.snapshot_id,
            fact_pack_id=request.fact_pack_id,
            fact_pack_version=request.fact_pack_version,
        )
    except LLMError as exc:
        provider = service.provider_name if service is not None else "llm"
        raise errors.LLMUnavailableError(str(exc), provider=provider) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_draft", "message": str(exc)}) from exc


@router.get("/llm/status", response_model=LLMStatusResponse)
def get_llm_status(
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    try:
        return service_factory(True).readiness()
    except errors.CoreError as exc:
        return {
            "ready": False,
            "provider": exc.provider or "llm",
            "model": "",
            "message": exc.message,
            "action": "AI 서버와 모델 설정을 확인한 뒤 다시 시도하세요.",
            "engine": exc.provider or "llm",
            "auth": "unknown",
            "quality_tier": "unknown",
        }


@router.post("/blogs/compose", status_code=201, response_model=BlogComposeResponse)
def compose_blog(
    request: BlogComposeRequest,
    service: BlogComposerService = Depends(get_blog_composer_service),
) -> dict:
    try:
        return service.compose(
            keyword=request.keyword,
            style=request.style,
            user_notes=request.user_notes,
            target_chars=request.target_chars,
            allow_sensitive_unknown=request.allow_sensitive_unknown,
            force_refresh=request.force_refresh,
            source_draft_id=request.source_draft_id,
            source_draft_mode=request.source_draft_mode,
        )
    except LLMError as exc:
        raise errors.LLMUnavailableError(str(exc), provider="llm") from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_compose", "message": str(exc)},
        ) from exc


@router.get("/drafts", response_model=DraftListResponse)
def list_drafts(
    query: str = Query(default="", max_length=200),
    status: Literal["editing", "review_ready", "archived"] | None = None,
    cursor: str | None = Query(default=None, max_length=500),
    limit: int = Query(default=20, ge=1, le=50),
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    try:
        return service_factory(False).list_drafts(
            query=query, status=status, cursor=cursor, limit=limit
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_cursor", "message": str(exc)},
        ) from exc


@router.get("/drafts/{draft_id}", response_model=DraftDetailResponse)
def get_draft(
    draft_id: int,
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    draft = service_factory(False).get_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "draft not found"})
    return draft


@router.patch("/drafts/{draft_id}/status", response_model=DraftStatusResponse)
def update_draft_status(
    draft_id: int,
    request: DraftStatusRequest,
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    try:
        updated = service_factory(False).update_status(draft_id, request.status)
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "invalid_status_transition", "message": str(exc)},
        ) from exc
    if updated is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "draft not found"}
        )
    return updated


@router.post("/factpacks", status_code=201, response_model=FactPackResponse)
def create_fact_pack(
    request: FactPackCreateRequest,
    service: FactPackService = Depends(get_fact_pack_service),
) -> dict:
    try:
        return service.create(request.snapshot_id, draft_id=request.draft_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_factpack", "message": str(exc)},
        ) from exc


@router.get("/factpacks/{fact_pack_id}", response_model=FactPackResponse)
def get_fact_pack(
    fact_pack_id: int,
    service: FactPackService = Depends(get_fact_pack_service),
) -> dict:
    pack = service.get(fact_pack_id)
    if pack is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "FactPack not found"}
        )
    return pack


@router.post(
    "/factpacks/{fact_pack_id}/versions",
    status_code=201,
    response_model=FactPackResponse,
)
def append_fact_pack_version(
    fact_pack_id: int,
    request: FactPackVersionCreateRequest,
    service: FactPackService = Depends(get_fact_pack_service),
) -> dict:
    try:
        pack = service.append_version(
            fact_pack_id,
            selected_evidence_ids=request.selected_evidence_ids,
            status=request.status,
            expected_version=request.expected_version,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_factpack", "message": str(exc)},
        ) from exc
    if pack is None:
        raise HTTPException(
            status_code=404, detail={"code": "not_found", "message": "FactPack not found"}
        )
    return pack


@router.post("/published-contents", status_code=201, response_model=PublishedContentResponse)
def create_published_content(
    request: PublishedContentCreateRequest,
    service: PublishedContentService = Depends(get_published_content_service),
) -> dict:
    try:
        return service.create(
            draft_id=request.draft_id,
            keyword_text=request.keyword,
            canonical_url=request.canonical_url,
            title=request.title,
            published_at=request.published_at,
            confirmed=request.confirmed,
        )
    except ValueError as exc:
        message = str(exc)
        status = 409 if "already registered" in message else 422
        raise HTTPException(
            status_code=status,
            detail={"code": "invalid_publication", "message": message},
        ) from exc


@router.get("/published-contents", response_model=PublishedContentListResponse)
def list_published_contents(
    query: str = Query(default="", max_length=200),
    include_archived: bool = False,
    service: PublishedContentService = Depends(get_published_content_service),
) -> dict:
    return service.list(query=query, include_archived=include_archived)


@router.patch("/published-contents/{content_id}", response_model=PublishedContentResponse)
def update_published_content(
    content_id: int,
    request: PublishedContentUpdateRequest,
    service: PublishedContentService = Depends(get_published_content_service),
) -> dict:
    try:
        updated = service.update(
            content_id,
            title=request.title,
            published_at=request.published_at,
            archived=request.archived,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "invalid_publication", "message": str(exc)},
        ) from exc
    if updated is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "published content not found"},
        )
    return updated


@router.post(
    "/drafts/{draft_id}/versions", status_code=201, response_model=DraftVersionCreatedResponse
)
def add_draft_version(
    draft_id: int,
    request: DraftVersionCreateRequest,
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    try:
        return service_factory(False).add_version(
            draft_id, request.title, request.body, note=request.note, expected_version=request.expected_version
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": str(exc)}) from exc


@router.post("/drafts/{draft_id}/assets", status_code=201, response_model=DraftAssetResponse)
def add_draft_asset(
    draft_id: int,
    request: DraftAssetCreateRequest,
    service: DraftAssetService = Depends(get_draft_asset_service),
) -> dict:
    try:
        return service.add(draft_id, **request.model_dump())
    except ValueError as exc:
        message = str(exc)
        status = 404 if "not found" in message else 409 if "locked" in message else 400
        raise HTTPException(status_code=status, detail={"code": "asset_invalid", "message": message}) from exc


@router.get("/drafts/{draft_id}/assets", response_model=list[DraftAssetResponse])
def list_draft_assets(
    draft_id: int,
    draft_version: int = Query(ge=1),
    service: DraftAssetService = Depends(get_draft_asset_service),
) -> list[dict]:
    return service.list(draft_id, draft_version)


@router.post(
    "/drafts/{draft_id}/assets/generate-guide",
    status_code=201,
    response_model=list[DraftAssetResponse],
)
def generate_draft_guide_assets(
    draft_id: int,
    request: DraftAssetGenerateRequest,
    service: DraftAssetService = Depends(get_draft_asset_service),
) -> list[dict]:
    try:
        return service.generate_guide_set(draft_id, request.draft_version, request.count)
    except ValueError as exc:
        message = str(exc)
        status = 404 if "not found" in message else 409 if "locked" in message else 400
        raise HTTPException(status_code=status, detail={"code": "asset_generation_failed", "message": message}) from exc


@router.delete("/drafts/{draft_id}/assets/{asset_id}", status_code=204)
def delete_draft_asset(
    draft_id: int,
    asset_id: int,
    service: DraftAssetService = Depends(get_draft_asset_service),
) -> None:
    try:
        deleted = service.delete(draft_id, asset_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "asset_locked", "message": str(exc)}) from exc
    if not deleted:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "draft asset not found"})


@router.get("/drafts/{draft_id}/assets/{asset_id}/content")
def draft_asset_content(
    draft_id: int,
    asset_id: int,
    service: DraftAssetService = Depends(get_draft_asset_service),
) -> FileResponse:
    row = service.get_row(asset_id)
    if row is None or row.draft_id != draft_id:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "draft asset not found"})
    try:
        row = service.verify_file(asset_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"code": "asset_invalid", "message": str(exc)}) from exc
    return FileResponse(row.local_path, media_type=row.mime_type,
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.post(
    "/drafts/{draft_id}/publish-jobs",
    status_code=202,
    response_model=PublishJobResponse,
)
def start_publish_job(
    draft_id: int,
    request: PublishJobCreateRequest,
    background_tasks: BackgroundTasks,
    service: PublishService = Depends(get_publish_service),
) -> dict:
    if request.transport == "current_chrome_extension":
        if not request.target_worker_id:
            raise HTTPException(status_code=409, detail={"code": "browser_transport_unavailable", "message": "현재 브라우저의 확장 연결을 먼저 확인하세요."})
        readiness = service.readiness(deps.get_settings().publisher_cdp_url, target_worker_id=request.target_worker_id)
        if not readiness["current_chrome_extension"]["ready"]:
            raise HTTPException(status_code=409, detail={"code": "browser_transport_unavailable", "message": "이 브라우저의 최신 확장 연결을 확인하세요. 다른 브라우저 연결로 실행하지 않습니다."})
    try:
        task = service.prepare(
            draft_id,
            blog_id=request.blog_id,
            tags=request.tags,
            cdp_url=deps.get_settings().publisher_cdp_url,
            expected_version=request.expected_version,
            transport=request.transport,
            target_worker_id=request.target_worker_id,
        )
    except PublishPreconditionError as exc:
        raise HTTPException(status_code=422, detail={"code": exc.code, "message": str(exc)}) from exc
    except (ValueError, errors.DraftVersionConflict) as exc:
        raise HTTPException(status_code=409, detail={"code": "publish_create_conflict", "message": str(exc)}) from exc
    if task is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "draft not found"})
    job = service.get_job(task.job_id)
    if job is None:
        raise HTTPException(
            status_code=500,
            detail={"code": "job_create_failed", "message": "publish job not created"},
        )
    if task.transport == "current_chrome_extension":
        service.mark_waiting_extension(task)
        job = service.get_job(task.job_id) or job
    elif not task.reused or job["status"] == "failed":
        background_tasks.add_task(service.run, task)
    return job


@router.get("/drafts/{draft_id}/publish-jobs/latest", response_model=PublishJobResponse | None)
def latest_publish_job(
    draft_id: int,
    service: PublishService = Depends(get_publish_service),
) -> dict | None:
    return service.latest_job(draft_id)


@router.get("/publish-jobs/{job_id}", response_model=PublishJobResponse)
def get_publish_job(
    job_id: int,
    service: PublishService = Depends(get_publish_service),
) -> dict:
    job = service.get_job(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail={"code": "not_found", "message": "publish job not found"},
        )
    return job


@router.get("/publish-jobs/{job_id}/command", response_model=PublishJobCommandResponse)
def get_publish_job_command(
    job_id: int,
    lease_owner: str | None = Query(default=None, min_length=1, max_length=100),
    service: PublishService = Depends(get_publish_service),
) -> dict:
    try:
        command = service.command(job_id, lease_owner=lease_owner)
    except (ValueError, errors.DraftVersionConflict) as exc:
        raise HTTPException(status_code=409, detail={"code": "publish_command_conflict", "message": str(exc)}) from exc
    if command is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "publish job not found"})
    return command


@router.get("/publisher/next-command", response_model=PublishJobCommandResponse | None)
def get_next_publish_command(
    lease_owner: str = Query(min_length=1, max_length=100),
    blog_id: list[str] = Query(default=[]),
    service: PublishService = Depends(get_publish_service),
) -> dict | None:
    try:
        return service.next_extension_command(lease_owner, blog_ids=blog_id)
    except (ValueError, errors.DraftVersionConflict) as exc:
        raise HTTPException(status_code=409, detail={"code": "publish_command_conflict", "message": str(exc)}) from exc


@router.get("/publish-jobs/{job_id}/assets/{asset_id}")
def download_publish_asset(
    job_id: int,
    asset_id: int,
    service: PublishService = Depends(get_publish_service),
):
    try:
        asset = service.asset_for_job(job_id, asset_id)
    except (ValueError, errors.DraftVersionConflict) as exc:
        raise HTTPException(status_code=409, detail={"code": "asset_integrity_conflict", "message": str(exc)}) from exc
    if asset is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "publish asset not found"})
    return FileResponse(
        asset.local_path,
        media_type=asset.mime_type,
        filename=asset.filename,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/publish-jobs/{job_id}/events", response_model=PublishJobResponse)
def record_publish_job_event(
    job_id: int,
    request: PublishJobEventRequest,
    service: PublishService = Depends(get_publish_service),
) -> dict:
    try:
        job = service.record_extension_event(job_id, **request.model_dump())
    except (ValueError, errors.DraftVersionConflict) as exc:
        raise HTTPException(status_code=409, detail={"code": "publish_event_conflict", "message": str(exc)}) from exc
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "publish job not found"})
    return job


@router.post("/publish-jobs/{job_id}/retry", response_model=PublishJobResponse)
def retry_publish_job(
    job_id: int,
    service: PublishService = Depends(get_publish_service),
) -> dict:
    try:
        job = service.retry(job_id)
    except (ValueError, errors.DraftVersionConflict) as exc:
        raise HTTPException(status_code=409, detail={"code": "publish_retry_conflict", "message": str(exc)}) from exc
    if job is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "publish job not found"})
    return job


@router.post("/publisher/extension-heartbeat")
def publisher_extension_heartbeat(
    request: PublisherHeartbeatRequest,
    service: PublishService = Depends(get_publish_service),
) -> dict:
    return service.heartbeat(**request.model_dump())


@router.get("/publisher/readiness")
def publisher_readiness(service: PublishService = Depends(get_publish_service), target_worker_id: str | None = Query(default=None, min_length=1, max_length=100)) -> dict:
    return service.readiness(deps.get_settings().publisher_cdp_url, target_worker_id=target_worker_id)
