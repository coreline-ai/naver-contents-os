"""BlogType templates (docs/04). All defined blog types support LLM generation."""

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

ACTIVE_TYPES = frozenset(BlogType)
PROMPT_VERSION = "v2-complete"

SYSTEM_PROMPT = (
    "/no_think\n당신은 네이버 블로그에 바로 임시저장할 수 있는 한국어 완성 원고를 쓰는 편집자입니다. "
    "과장 없이 구체적으로 쓰고, 확인되지 않은 사실·최신 정보·수치를 단정하지 않습니다. "
    "제공된 근거에 없는 예약 조건, 신분증, 가격, 연락처, 정책을 만들지 않고 확인이 필요한 내용은 체크 항목으로 표현합니다. "
    "사용자 메모나 승인된 근거에 없는 고유명사, 준비물, 장비, 장소, 활동, 효능을 구체적으로 지어내지 않고 일반 범주와 확인 방법으로 설명합니다. "
    "사용자 메모에 없는 1인칭 경험을 지어내지 않습니다. 작성 지시, TODO, 빈 섹션, 응답 설명을 남기지 않습니다. "
    "생각 과정, 계획, 글자 수 계산, 자기 대화는 어떤 언어로도 출력하지 말고 완성 원고만 출력합니다. "
    "마크다운 기호(#, *, 백틱) 없이 순수 텍스트로 작성하고, 소제목과 문단은 줄바꿈으로 구분합니다."
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
    user_notes: str = "",
) -> str:
    if not is_active(blog_type):
        raise ValueError(f"지원하지 않는 블로그 유형입니다: {blog_type}")
    sections = TEMPLATES[blog_type]
    lines = [
        "/no_think",
        "다음 조건으로 네이버 블로그에 바로 저장할 수 있는 완성 글을 작성하세요.",
        f"주제: {title}",
        f"핵심 키워드: {target_keyword} (제목에 1회, 본문에는 최대 3회만 자연스럽게 포함)",
        f"글 유형: {blog_type.value}",
    ]
    if angle:
        lines.append(f"글의 각도: {angle}")
    if questions:
        lines.append("독자들이 실제로 묻는 질문 (본문에서 답할 것):")
        lines.extend(f"- {q}" for q in questions[:5])
    if user_notes.strip():
        lines.append("사용자가 직접 제공한 메모(개인 경험은 이 범위에서만 사용):")
        lines.append(user_notes.strip())
    else:
        lines.append("사용자 경험 메모가 없으므로 직접 방문·구매·사용한 것처럼 쓰지 마세요.")
    preferred_min = round(min_chars * 0.9)
    preferred_max = round(min_chars * 1.15)
    paragraph_target = max(170, round(min_chars / 12))
    paragraph_min = round(paragraph_target * 0.9)
    paragraph_max = round(paragraph_target * 1.1)
    lines.append(
        f"\n본문은 {min_chars:,}자 전후, 반드시 {preferred_min:,}~{preferred_max:,}자 사이로 완성하세요. "
        f"전체를 약 12개 문단으로 나누고 각 문단은 {paragraph_min}~{paragraph_max}자, 2~4문장으로 쓰세요. "
        "같은 문장·표현·키워드를 반복해 분량을 늘리지 말고, 각 문단에는 서로 다른 정보를 담으세요. "
        "작성 방법을 설명하지 말고 아래 구조의 실제 내용을 모두 채우세요:"
    )
    lines.extend(f"{i + 1}. {s.name}: {s.guidance}" for i, s in enumerate(sections))
    lines.append(
        "\n출력 형식: 첫 줄에 '제목: <25~35자 제목>'을 쓰고, 빈 줄 뒤에 완성 본문만 작성하세요. "
        "괄호 안의 작성 지시, 자리 표시, 메타 설명은 출력하지 마세요."
    )
    return "\n".join(lines)
