from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from app import deps, errors
from app.auth import require_token
from app.services.analyze import AnalyzeService
from app.services.drafts import DraftService
from app.services.factpacks import FactPackService
from app.services.intent import IntentBoardService
from app.services.work import TodayWorkService
from app.services.publishing import PublishService
from app.services.published import PublishedContentService
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
        "inspect_error", "resume_draft", "register_publication", "refresh_data", "open_analysis"
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


@router.get("/capabilities")
def get_capabilities(service: ResearchService = Depends(get_research_service)) -> dict:
    return service.capabilities()


@router.get("/work/today", response_model=TodayWorkResponse)
def get_today_work(
    limit: int = Query(default=5, ge=1, le=5),
    service: TodayWorkService = Depends(get_today_work_service),
) -> dict:
    return service.list(limit=limit)


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
    latest_job_status: Literal["none", "pending", "draft_saved", "failed"]
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
            draft_id, request.title, request.body, note=request.note
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": str(exc)}) from exc


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
    task = service.prepare(
        draft_id,
        blog_id=request.blog_id,
        tags=request.tags,
        cdp_url=deps.get_settings().publisher_cdp_url,
    )
    if task is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "draft not found"})
    job = service.get_job(task.job_id)
    if job is None:
        raise HTTPException(
            status_code=500,
            detail={"code": "job_create_failed", "message": "publish job not created"},
        )
    background_tasks.add_task(service.run, task)
    return job


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
