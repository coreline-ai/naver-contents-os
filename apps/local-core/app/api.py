from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from app import deps, errors
from app.auth import require_token
from app.services.analyze import AnalyzeService
from app.services.drafts import DraftService
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


@router.post("/drafts", status_code=201, response_model=DraftCreateResponse)
def create_draft(
    request: DraftCreateRequest,
    service_factory: Callable[[bool], DraftService] = Depends(get_draft_service_factory),
) -> dict:
    try:
        service = service_factory(request.generation_mode == "llm")
        return service.create_draft(
            request.keyword,
            request.plan_item.model_dump(mode="json"),
            request.questions,
            snapshot_id=request.snapshot_id,
        )
    except LLMError as exc:
        raise errors.LLMUnavailableError(str(exc), provider="ollama") from exc
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
