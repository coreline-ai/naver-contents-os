"""One-action blog composition built from the existing research and draft services."""

from __future__ import annotations

from collections.abc import Callable

from app.services.analyze import AnalyzeService
from app.services.drafts import DraftService
from app.services.factpacks import FactPackService
from app.services.research import ResearchService
from intelligence.keyword.models import normalize_keyword
from planner.series import infer_blog_type
from planner.types import BlogType


STYLE_TYPES: dict[str, BlogType | None] = {
    "auto": None,
    "informational": BlogType.HOWTO,
    "review": BlogType.REVIEW,
    "product": BlogType.PRODUCT,
}


class BlogComposerService:
    def __init__(
        self,
        analyze_service: AnalyzeService,
        research_service: ResearchService,
        fact_pack_service: FactPackService,
        draft_service_factory: Callable[[bool], DraftService],
    ):
        self._analyze = analyze_service
        self._research = research_service
        self._factpacks = fact_pack_service
        self._drafts = draft_service_factory

    @staticmethod
    def _select_plan(keyword: str, plan: list[dict], style: str) -> dict:
        requested = STYLE_TYPES[style]
        desired = requested or infer_blog_type(keyword)
        ready = [item for item in plan if item.get("generation_status") == "ready"]
        selected = next((item for item in ready if item.get("blog_type") == desired.value), None)
        if selected is None and style == "auto":
            # A general one-click article should be useful on its own, not a series hub.
            selected = next(
                (item for item in ready if item.get("blog_type") in {BlogType.HOWTO.value, BlogType.REVIEW.value, BlogType.PRODUCT.value}),
                None,
            )
        if selected is None and ready:
            selected = ready[0]
        if selected is not None:
            copied = dict(selected)
            if requested is not None:
                copied["blog_type"] = requested.value
            copied["target_keyword"] = keyword
            copied["title"], copied["angle"] = BlogComposerService._topic_frame(
                keyword, BlogType(copied["blog_type"])
            )
            return copied
        title, angle = BlogComposerService._topic_frame(keyword, desired)
        return {
            "order": 1,
            "title": title,
            "blog_type": desired.value,
            "target_keyword": keyword,
            "angle": angle,
            "reason": "자동 완성 글 기본 계획",
            "generation_status": "ready",
            "series_prev": None,
            "series_next": None,
        }

    @staticmethod
    def _topic_frame(keyword: str, blog_type: BlogType) -> tuple[str, str]:
        if blog_type == BlogType.PRODUCT:
            return (
                f"{keyword} 비교와 구매 전 체크리스트",
                "선택 기준, 장단점, 대안을 근거 범위 안에서 정리하는 구매 안내",
            )
        if blog_type == BlogType.REVIEW:
            return (
                f"{keyword} 선택 전에 보는 장단점 정리",
                "사용자 메모에 있는 경험만 활용하고 추천 대상을 구분하는 균형 잡힌 후기",
            )
        return (
            f"{keyword} 준비부터 실행까지 한 번에",
            "처음 찾아보는 독자가 준비와 실행 순서를 이해할 수 있는 완결형 안내",
        )

    @staticmethod
    def _tags(keyword: str, analysis: dict) -> list[str]:
        values = [keyword]
        for item in analysis.get("related_keywords", []):
            candidate = normalize_keyword(str(item.get("keyword") or ""))
            if candidate:
                values.append(candidate)
        result: list[str] = []
        seen: set[str] = set()
        for value in values:
            tag = value.replace(" ", "")[:30]
            key = tag.casefold()
            if not tag or key in seen:
                continue
            seen.add(key)
            result.append(tag)
            if len(result) == 10:
                break
        return result

    def compose(
        self,
        *,
        keyword: str,
        style: str = "auto",
        user_notes: str = "",
        target_chars: int = 2500,
        allow_sensitive_unknown: bool = False,
        force_refresh: bool = False,
        source_draft_id: int | None = None,
        source_draft_mode: str = "revision",
    ) -> dict:
        normalized = normalize_keyword(keyword)
        if style not in STYLE_TYPES:
            raise ValueError("unsupported blog style")
        if source_draft_mode not in {"revision", "followup"}:
            raise ValueError("unsupported source draft mode")

        source_context = ""
        if source_draft_id is not None:
            source_draft = self._drafts(False).get_draft(source_draft_id)
            if source_draft is None:
                raise ValueError("source draft not found")
            if source_draft_mode == "revision" and source_draft["keyword"] != normalized:
                raise ValueError("source draft does not belong to keyword")
            versions = source_draft.get("versions") or []
            if not versions:
                raise ValueError("source draft has no versions")
            latest = max(versions, key=lambda item: int(item.get("version") or 0))
            source_context = (
                ("기존 글을 덮어쓰지 않고 다른 검색 의도의 별도 후속 글을 작성하세요.\n" if source_draft_mode == "followup" else "") +
                "기존 발행 글에 연결된 최신 Draft를 참고하되 근거 없는 새 사실을 추가하지 마세요.\n"
                f"기존 Draft #{source_draft_id} v{latest.get('version')} 제목: {latest.get('title') or source_draft.get('title') or ''}\n"
                f"기존 본문:\n{str(latest.get('body') or '')[:6000]}"
            )

        preflight = self._research.preflight(normalized, force_refresh=force_refresh)
        if preflight.get("sensitive") is True:
            raise ValueError("민감 키워드로 판별되어 자동 글 작성을 중지했습니다.")
        if preflight.get("sensitive") is None and not allow_sensitive_unknown:
            raise ValueError(
                "민감 키워드 확인을 완료하지 못했습니다. 설정에서 '판별 불가 시 AI 사용'을 허용하세요."
            )

        analysis = self._analyze.analyze(normalized, force_refresh=force_refresh)
        plan_item = self._select_plan(normalized, analysis.get("plan", []), style)
        if source_draft_id is not None:
            plan_item["source_draft_id"] = source_draft_id
            plan_item["source_draft_mode"] = source_draft_mode
        # Search metadata is useful for topic discovery, but it has not been
        # reviewed by the user and must not be silently promoted to approved
        # factual evidence. Search-derived questions can contain adjacent but
        # unrelated entities, so the one-action flow writes only from the topic
        # and explicit user notes. A reviewed FactPack can still be attached
        # through the detailed tools.
        fact_pack_id, fact_pack_version = None, None
        draft = self._drafts(True).create_draft(
            normalized,
            plan_item,
            [],
            snapshot_id=analysis["snapshot_id"],
            fact_pack_id=fact_pack_id,
            fact_pack_version=fact_pack_version,
            user_notes="\n\n".join(value for value in (user_notes, source_context) if value),
            target_chars=target_chars,
            enforce_quality=True,
        )
        metric = analysis.get("metric") or {}
        return {
            "keyword": normalized,
            "snapshot_id": analysis["snapshot_id"],
            "draft": {key: value for key, value in draft.items() if key != "quality"},
            "quality": draft["quality"],
            "suggested_tags": self._tags(normalized, analysis),
            "analysis_summary": {
                "monthly_searches": metric.get("monthly_total_searches"),
                "related_keyword_count": len(analysis.get("related_keywords", [])),
                "question_count": len(analysis.get("questions", [])),
                "data_status": analysis.get("data_status", {}),
            },
            "fact_pack_id": fact_pack_id,
            "fact_pack_version": fact_pack_version,
            "preflight": preflight,
        }
