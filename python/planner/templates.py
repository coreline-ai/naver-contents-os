"""BlogType templates (docs/04). V1 activates HOWTO·POLICY·REVIEW for generation;
the remaining five keep their structure defined but are not wired to the LLM yet."""

from __future__ import annotations

from dataclasses import dataclass

from planner.types import BlogType


@dataclass(frozen=True)
class TemplateSection:
    name: str
    guidance: str


TEMPLATES: dict[BlogType, tuple[TemplateSection, ...]] = {
    BlogType.HOWTO: (
        TemplateSection("문제 제기", "독자가 겪는 문제 상황에 공감하며 시작"),
        TemplateSection("준비물", "시작 전에 필요한 조건과 준비물"),
        TemplateSection("단계별 방법", "번호를 붙인 구체적 실행 단계"),
        TemplateSection("자주 나는 오류", "실수·오류 사례와 해결법"),
        TemplateSection("FAQ", "실제로 자주 묻는 질문과 짧은 답"),
    ),
    BlogType.POLICY: (
        TemplateSection("결론 요약", "가장 궁금한 결론을 먼저 제시"),
        TemplateSection("조건", "적용 조건을 항목별로 정리"),
        TemplateSection("예외", "예외 상황과 유의점"),
        TemplateSection("신청 방법", "절차를 순서대로 안내"),
        TemplateSection("주의사항", "실패·반려 사례 기반 주의점"),
    ),
    BlogType.REVIEW: (
        TemplateSection("사용 배경", "왜 쓰게 되었는지 개인적 맥락"),
        TemplateSection("실제 경험", "구체적 수치·기간이 있는 경험담"),
        TemplateSection("장점", "체감한 장점"),
        TemplateSection("단점", "아쉬운 점을 솔직하게"),
        TemplateSection("결론", "어떤 사람에게 맞는지 정리"),
    ),
    # structure-only in V1 (docs/04의 8유형 중 나머지)
    BlogType.COMPARISON: (
        TemplateSection("요약", ""), TemplateSection("A 소개", ""), TemplateSection("B 소개", ""),
        TemplateSection("비교표", ""), TemplateSection("추천 대상", ""),
    ),
    BlogType.HOMEFEED: (
        TemplateSection("Hook", ""), TemplateSection("핵심 사실", ""),
        TemplateSection("이야기", ""), TemplateSection("추가 정보", ""),
    ),
    BlogType.PRODUCT: (
        TemplateSection("문제", ""), TemplateSection("제품 소개", ""), TemplateSection("장단점", ""),
        TemplateSection("대안", ""), TemplateSection("구매 체크", ""),
    ),
    BlogType.NEWS: (
        TemplateSection("사건", ""), TemplateSection("핵심 사실", ""),
        TemplateSection("배경", ""), TemplateSection("영향", ""),
    ),
    BlogType.SERIES: (
        TemplateSection("앞편 연결", ""), TemplateSection("이번 질문", ""),
        TemplateSection("답", ""), TemplateSection("다음편 예고", ""),
    ),
}

ACTIVE_TYPES = frozenset({BlogType.HOWTO, BlogType.POLICY, BlogType.REVIEW})

SYSTEM_PROMPT = (
    "당신은 네이버 블로그 글을 쓰는 한국어 작가입니다. 과장 없이 구체적으로 쓰고, "
    "확인되지 않은 사실은 단정하지 않습니다. 마크다운 기호(#, *, 백틱) 없이 "
    "순수 텍스트로 작성하고, 섹션 제목은 줄바꿈으로만 구분합니다."
)


def is_active(blog_type: BlogType) -> bool:
    return blog_type in ACTIVE_TYPES


def build_prompt(
    title: str,
    target_keyword: str,
    blog_type: BlogType,
    angle: str = "",
    questions: list[str] | None = None,
    min_chars: int = 2500,
) -> str:
    if not is_active(blog_type):
        raise ValueError(f"{blog_type} 템플릿은 V1에서 구조만 정의되어 있습니다 (생성 미지원)")
    sections = TEMPLATES[blog_type]
    lines = [
        f"다음 조건으로 네이버 블로그 글을 작성하세요.",
        f"주제: {title}",
        f"핵심 키워드: {target_keyword} (제목과 본문에 자연스럽게 포함)",
        f"글 유형: {blog_type.value}",
    ]
    if angle:
        lines.append(f"글의 각도: {angle}")
    if questions:
        lines.append("독자들이 실제로 묻는 질문 (본문에서 답할 것):")
        lines.extend(f"- {q}" for q in questions[:5])
    lines.append(f"\n본문은 {min_chars}자 이상, 아래 섹션 순서를 따르세요:")
    lines.extend(f"{i + 1}. {s.name}: {s.guidance}" for i, s in enumerate(sections))
    lines.append("\n출력 형식: 첫 줄에 '제목: <25~35자 제목>'을 쓰고, 빈 줄 뒤에 본문을 작성하세요.")
    return "\n".join(lines)
