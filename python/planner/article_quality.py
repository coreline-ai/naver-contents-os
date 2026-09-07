"""Deterministic quality checks for publish-ready Korean blog drafts.

The checks deliberately avoid subjective style scoring. They only guard the failure
modes that make a generated article unusable: an unfinished body, leaked writing
instructions, missing topic coverage, or a response that talks about writing instead
of being the article.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re

from intelligence.keyword.models import compact


PLACEHOLDER_FRAGMENTS = (
    "내용을 입력",
    "여기에 작성",
    "추후 작성",
    "TODO",
    "독자가 겪는 문제 상황에 공감하며 시작",
    "시작 전에 필요한 조건과 준비물",
    "번호를 붙인 구체적 실행 단계",
    "실수·오류 사례와 해결법",
    "실제로 자주 묻는 질문과 짧은 답",
    "구체적 수치·기간이 있는 경험담",
)

META_FRAGMENTS = (
    "다음은 요청하신",
    "요청하신 글을",
    "아래와 같이 작성",
    "물론입니다",
    "AI로서",
    "초안을 작성해 드리",
    "okay, let me",
    "the user wants",
    "first, i need",
    "i need to make sure",
    "let me check",
    "let me outline",
    "let me start drafting",
    "the main topic is",
)

HIGH_RISK_ADVICE_FRAGMENTS = (
    "주민등록번호",
    "여권번호",
    "계좌번호",
    "카드번호",
    "비밀번호",
    "인증번호",
)


@dataclass(frozen=True)
class ArticleQualityReport:
    passed: bool
    score: int
    char_count: int
    target_chars: int
    paragraph_count: int
    keyword_count: int
    issues: list[str]
    checks: dict[str, bool]
    repair_attempted: bool = False

    def payload(self, *, repair_attempted: bool | None = None) -> dict:
        value = asdict(self)
        if repair_attempted is not None:
            value["repair_attempted"] = repair_attempted
        return value


def _keyword_count(body: str, keyword: str) -> int:
    needle = compact(keyword).casefold()
    if not needle:
        return 0
    return compact(body).casefold().count(needle)


def _sentence_variety(body: str) -> tuple[float, int]:
    sentences = [
        compact(sentence).casefold()
        for sentence in re.split(r"(?<=[.!?])\s+|\n+", body)
        if len(compact(sentence)) >= 15
    ]
    if not sentences:
        return 0.0, 0
    counts = {sentence: sentences.count(sentence) for sentence in set(sentences)}
    return len(counts) / len(sentences), max(counts.values())


def evaluate_article(
    title: str,
    body: str,
    keyword: str,
    *,
    target_chars: int = 2500,
) -> ArticleQualityReport:
    """Return an explainable quality result without changing the generated text."""

    normalized_title = title.strip()
    normalized_body = body.strip()
    char_count = len(normalized_body)
    # A structured section commonly uses one newline between its heading and
    # content. Count blank-line-delimited content blocks rather than treating
    # every heading line as a separate paragraph.
    paragraphs = [row.strip() for row in re.split(r"\n\s*\n+", normalized_body) if row.strip()]
    paragraph_count = len(paragraphs)
    combined_text = f"{normalized_title}\n{normalized_body}"
    keyword_count = _keyword_count(combined_text, keyword)
    keyword_tokens = [token for token in keyword.split() if len(compact(token)) >= 2]
    token_coverage = (
        sum(compact(token).casefold() in compact(combined_text).casefold() for token in keyword_tokens)
        / len(keyword_tokens)
        if keyword_tokens
        else 0.0
    )
    hangul_count = len(re.findall(r"[가-힣]", normalized_body))
    latin_count = len(re.findall(r"[A-Za-z]", normalized_body))
    sentence_variety, max_sentence_repeats = _sentence_variety(normalized_body)
    minimum_chars = max(1200, round(target_chars * 0.85))
    maximum_chars = max(target_chars + 1200, round(target_chars * 1.65))

    has_placeholder = any(fragment.casefold() in normalized_body.casefold() for fragment in PLACEHOLDER_FRAGMENTS)
    has_meta = any(fragment.casefold() in normalized_body.casefold() for fragment in META_FRAGMENTS)
    has_high_risk_advice = any(
        fragment.casefold() in normalized_body.casefold()
        for fragment in HIGH_RISK_ADVICE_FRAGMENTS
    )
    has_template_brackets = bool(
        re.search(r"\[(?:내용|본문|사진|이미지|작성|입력)[^\]]*\]", normalized_body, re.IGNORECASE)
    )

    checks = {
        "title_ready": 10 <= len(normalized_title) <= 60,
        "length_ready": minimum_chars <= char_count <= maximum_chars,
        "paragraphs_ready": (8 if target_chars <= 3000 else 10) <= paragraph_count <= 22,
        "keyword_ready": keyword_count <= 12 and token_coverage >= 0.75,
        "no_placeholders": not (has_placeholder or has_template_brackets),
        "no_meta_commentary": not has_meta,
        "no_high_risk_advice": not has_high_risk_advice,
        "korean_ready": hangul_count >= 300 and hangul_count >= latin_count * 2,
        "variety_ready": sentence_variety >= 0.85 and max_sentence_repeats <= 1,
        "finished_ending": normalized_body.endswith((".", "!", "?", "다", "요", "죠")),
    }

    weights = {
        "title_ready": 5,
        "length_ready": 20,
        "paragraphs_ready": 10,
        "keyword_ready": 15,
        "no_placeholders": 10,
        "no_meta_commentary": 10,
        "no_high_risk_advice": 10,
        "korean_ready": 5,
        "variety_ready": 10,
        "finished_ending": 5,
    }
    score = sum(weights[name] for name, passed in checks.items() if passed)
    issues: list[str] = []
    if not checks["title_ready"]:
        issues.append("제목을 10~60자의 완성된 문장으로 다듬으세요.")
    if not checks["length_ready"]:
        issues.append(f"본문을 목표 {target_chars:,}자에 맞게 충분히 작성하세요(현재 {char_count:,}자).")
    if not checks["paragraphs_ready"]:
        issues.append("독자가 읽기 쉽도록 소제목과 문단을 더 구체적으로 나누세요.")
    if not checks["keyword_ready"]:
        issues.append("핵심 키워드를 제목에 포함하고 본문에서도 구성 단어를 자연스럽게 사용하세요.")
    if not checks["no_placeholders"]:
        issues.append("작성 지시·TODO·빈 자리 표시를 제거하고 실제 본문으로 채우세요.")
    if not checks["no_meta_commentary"]:
        issues.append("생각 과정·작성 계획·메타 문구를 제거하고 한국어 완성 본문만 작성하세요.")
    if not checks["no_high_risk_advice"]:
        issues.append("주민등록번호·계좌번호·비밀번호 등 민감정보를 수집·저장·공유하라는 조언을 제거하세요.")
    if not checks["korean_ready"]:
        issues.append("영문 사고 과정 대신 한국어 블로그 본문을 충분히 작성하세요.")
    if not checks["variety_ready"]:
        issues.append("반복되는 문장과 문단을 제거하고 각 섹션에 서로 다른 정보를 담으세요.")
    if not checks["finished_ending"]:
        issues.append("마지막 문단을 완성된 문장으로 마무리하세요.")

    critical = (
        not checks["length_ready"]
        or not checks["no_placeholders"]
        or not checks["no_meta_commentary"]
        or not checks["no_high_risk_advice"]
        or not checks["korean_ready"]
        or not checks["variety_ready"]
        or keyword_count > 12
        or token_coverage < 0.5
        or not normalized_body
    )
    return ArticleQualityReport(
        passed=not critical and score >= 80,
        score=score,
        char_count=char_count,
        target_chars=target_chars,
        paragraph_count=paragraph_count,
        keyword_count=keyword_count,
        issues=issues,
        checks=checks,
    )


def build_repair_prompt(
    *,
    title: str,
    body: str,
    keyword: str,
    target_chars: int,
    issues: list[str],
) -> str:
    issue_lines = "\n".join(f"- {issue}" for issue in issues)
    preferred_min = round(target_chars * 0.9)
    preferred_max = round(target_chars * 1.15)
    paragraph_target = max(170, round(target_chars / 12))
    return (
        "/no_think\n"
        "아래 원고를 네이버 블로그에 바로 저장할 수 있는 완성 글로 다시 작성하세요.\n"
        "사실, 숫자, 개인 경험을 새로 만들지 말고 원문에 있는 정보만 유지하세요.\n"
        "생각 과정, 작성 계획, 글자 수 계산, 수정 설명을 어떤 언어로도 출력하지 마세요.\n"
        f"핵심 키워드: {keyword}\n"
        f"목표 길이: {target_chars:,}자(반드시 {preferred_min:,}~{preferred_max:,}자 사이, 총 12문단, "
        f"문단당 약 {paragraph_target}자)\n"
        f"보정할 항목:\n{issue_lines}\n\n"
        f"기존 제목: {title}\n\n"
        f"기존 본문:\n{body}\n\n"
        "출력 형식: 첫 줄은 '제목: <제목>', 빈 줄 뒤에 수정된 완성 본문만 작성하세요."
    )


def build_expansion_prompt(
    *,
    title: str,
    body: str,
    keyword: str,
    target_chars: int,
    round_index: int = 0,
) -> str:
    """Ask for non-repeating addendum sections when a clean draft is only short."""

    missing = max(500, target_chars - len(body))
    minimum = max(450, round(missing * 0.9))
    maximum = round(missing * 1.2)
    blocks = [block.strip() for block in re.split(r"\n\s*\n+", body) if block.strip()]
    headings = [block.splitlines()[0].strip() for block in blocks if block.splitlines()]
    forbidden = ", ".join(headings[-16:]) or "없음"
    focus_options = (
        "기존 목록에서 빠진 준비 순서와 실행 판단 기준",
        "현장에서 생길 수 있는 변수에 대응하는 확인 질문과 주의점",
        "독자가 바로 따라 할 수 있는 최종 점검 순서와 짧은 FAQ",
    )
    focus = focus_options[min(max(round_index, 0), len(focus_options) - 1)]
    return (
        "/no_think\n"
        "아래 원고에 바로 이어 붙일 추가 본문만 작성하세요.\n"
        "기존 내용을 반복·요약하지 말고, 누락된 실전 체크리스트·주의사항·FAQ를 4~6개 문단으로 보충하세요.\n"
        f"이번 보강의 초점: {focus}\n"
        f"이미 사용했으므로 다시 쓰지 말아야 할 소제목과 주제: {forbidden}\n"
        "새 소제목은 위 목록과 의미가 겹치지 않아야 하며 기존 문장을 그대로 다시 쓰면 안 됩니다.\n"
        "새로운 사실, 숫자, 가격, 정책, 개인 경험을 지어내지 마세요.\n"
        "생각 과정과 수정 설명을 출력하지 마세요.\n"
        f"핵심 키워드: {keyword}\n"
        f"추가 분량: 반드시 {minimum:,}~{maximum:,}자\n\n"
        f"기존 제목: {title}\n\n"
        f"기존 본문:\n{body}\n\n"
        "출력 형식: 첫 줄은 '제목: 추가 본문', 빈 줄 뒤에 이어 붙일 추가 본문만 작성하세요."
    )
