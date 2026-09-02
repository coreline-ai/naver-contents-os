from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from app import deps, errors
from app.auth import require_token
from app.services.analyze import AnalyzeService
from app.services.drafts import DraftService
from app.services.publishing import PublishService
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


@router.get("/capabilities")
def get_capabilities(service: ResearchService = Depends(get_research_service)) -> dict:
    return service.capabilities()


@router.get("/snapshots/{snapshot_id}")
def get_snapshot(
    snapshot_id: int, service: ResearchService = Depends(get_research_service)
) -> dict:
    snapshot = service.snapshot(snapshot_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "snapshot not found"})
    return snapshot


@router.post("/keywords/preflight")
def preflight_keyword(
    request: KeywordResearchRequest,
    service: ResearchService = Depends(get_research_service),
) -> dict:
    return service.preflight(request.keyword, force_refresh=request.force_refresh)


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

    @field_validator("keyword")
    @classmethod
    def normalize_draft_keyword(cls, value: str) -> str:
        normalized = normalize_keyword(value)
        if not normalized:
            raise ValueError("keyword must contain non-whitespace characters")
        return normalized

    @model_validator(mode="after")
    def validate_generation_support(self):
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
    provider: str
    model: str
    prompt_version: str


class DraftVersionView(BaseModel):
    version: int
    title: str
    body: str
    note: str


class DraftDetailResponse(BaseModel):
    draft_id: int
    blog_type: str
    title: str
    source_snapshot_id: int | None
    plan: dict
    provider: str
    model: str
    prompt_version: str
    versions: list[DraftVersionView]


class DraftVersionCreatedResponse(BaseModel):
    draft_id: int
    version: int


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
        )
    except LLMError as exc:
        provider = service.provider_name if service is not None else "llm"
        raise errors.LLMUnavailableError(str(exc), provider=provider) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_draft", "message": str(exc)}) from exc


@router.get("/drafts/{draft_id}", response_model=DraftDetailResponse)
def get_draft(
    draft_id: int,
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    draft = service_factory(False).get_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "draft not found"})
    return draft


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
