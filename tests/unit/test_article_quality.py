from planner.article_quality import build_expansion_prompt, build_repair_prompt, evaluate_article


def _complete_body(keyword: str, target_chars: int = 2500) -> str:
    paragraphs = [
        f"{keyword}를 처음 알아볼 때는 목적과 현재 상황을 먼저 정리하는 것이 중요합니다.",
        "준비 단계에서는 필요한 조건을 확인하고 확인되지 않은 정보는 별도로 표시해야 합니다.",
        "첫 번째 단계는 목표를 구체적인 질문으로 바꾸는 일입니다. 그래야 조사 범위가 불필요하게 넓어지지 않습니다.",
        "두 번째 단계는 공식 자료와 최근 자료를 구분해 살펴보는 일입니다. 날짜가 오래된 내용은 현재도 유효한지 다시 확인합니다.",
        "세 번째 단계에서는 찾은 내용을 독자가 실행할 수 있는 순서로 정리합니다. 핵심부터 설명하면 이해가 쉬워집니다.",
        "주의할 점은 숫자나 개인 경험을 근거 없이 덧붙이지 않는 것입니다. 모르는 내용은 모른다고 구분하는 편이 안전합니다.",
        f"실제로 글을 구성할 때는 {keyword}라는 표현을 같은 문단에 반복하기보다 필요한 위치에 자연스럽게 배치합니다.",
        "자주 묻는 질문은 본문의 설명만으로 해결되지 않는 부분을 보완하는 데 사용합니다.",
        "마지막에는 독자가 바로 확인할 수 있는 항목을 짧게 요약하고 다음 행동을 분명하게 안내합니다.",
        "이 과정을 따르면 정보의 출처와 글의 목적이 분명한 완성 원고를 만들 수 있습니다.",
    ]
    index = 0
    while len("\n\n".join(paragraphs)) < round(target_chars * 0.92):
        paragraphs[index % len(paragraphs)] += (
            f" {index + 1}번 점검 근거의 범위와 기준을 함께 적으면 "
            "독자가 내용을 판단하기 쉽고 이후 수정할 때도 자료를 다시 찾기 편합니다."
        )
        index += 1
    return "\n\n".join(paragraphs)


def test_complete_article_passes_deterministic_checks():
    report = evaluate_article(
        "초보자를 위한 콘텐츠 작성 핵심 안내",
        _complete_body("콘텐츠 작성"),
        "콘텐츠 작성",
    )

    assert report.passed is True
    assert report.score >= 80
    assert report.checks["length_ready"] is True
    assert report.checks["no_placeholders"] is True


def test_skeleton_and_meta_response_are_rejected():
    body = "다음은 요청하신 글을 아래와 같이 작성했습니다.\n\n단계별 방법\n(번호를 붙인 구체적 실행 단계)\n\n[내용 입력]"
    report = evaluate_article("짧은 제목", body, "테스트")

    assert report.passed is False
    assert report.checks["no_placeholders"] is False
    assert report.checks["no_meta_commentary"] is False
    assert any("작성 지시" in issue for issue in report.issues)


def test_english_reasoning_leak_is_rejected_even_when_long_enough():
    reasoning = (
        "Okay, let me try to tackle this. The user wants a blog post. "
        "First, I need to make sure the title is correct. " * 80
    )
    report = evaluate_article("충분히 긴 테스트 블로그 제목입니다", reasoning, "테스트")

    assert report.passed is False
    assert report.checks["no_meta_commentary"] is False
    assert report.checks["korean_ready"] is False


def test_repeated_sentence_stuffing_is_rejected():
    repeated = "핵심 키워드는 출발 전에 꼼꼼히 확인해야 하는 중요한 준비 항목입니다."
    body = "\n\n".join([repeated] * 35)
    report = evaluate_article("핵심 키워드 완성 안내 제목", body, "핵심 키워드")

    assert report.passed is False
    assert report.checks["variety_ready"] is False
    assert any("반복되는 문장" in issue for issue in report.issues)


def test_keyword_stuffing_is_critical_even_when_sentences_are_distinct():
    stuffed = "\n\n".join(
        f"핵심 키워드 점검 항목 {index}은 서로 다른 준비 상황을 설명하는 문장입니다."
        for index in range(13)
    )
    body = f"{_complete_body('핵심 키워드')}\n\n{stuffed}"
    report = evaluate_article("핵심 키워드 활용을 위한 완성 안내", body, "핵심 키워드")

    assert report.keyword_count > 12
    assert report.checks["keyword_ready"] is False
    assert report.passed is False


def test_high_risk_personal_identifier_advice_is_rejected():
    body = _complete_body("여행 준비") + "\n\n아이의 주민등록번호를 메모장에 저장해 두세요."
    report = evaluate_article("안전한 여행 준비를 위한 완성 안내", body, "여행 준비")

    assert report.passed is False
    assert report.checks["no_high_risk_advice"] is False
    assert any("민감정보" in issue for issue in report.issues)


def test_long_tail_keyword_accepts_title_match_and_body_token_coverage():
    body = _complete_body("가족여행 준비물")
    report = evaluate_article(
        "제주도 가족여행 준비물 준비부터 실행까지 한 번에",
        body,
        "제주도 가족여행 준비물",
    )

    assert report.keyword_count == 1
    assert report.checks["keyword_ready"] is True
    assert report.passed is True


def test_repair_prompt_keeps_source_and_explicitly_forbids_invention():
    prompt = build_repair_prompt(
        title="기존 제목",
        body="기존 본문",
        keyword="핵심 키워드",
        target_chars=4000,
        issues=["본문이 짧습니다."],
    )

    assert "사실, 숫자, 개인 경험을 새로 만들지 말고" in prompt
    assert "목표 길이: 4,000자(반드시 3,600~4,600자 사이, 총 12문단" in prompt
    assert "기존 본문" in prompt


def test_expansion_prompt_requests_only_missing_non_repeating_sections():
    prompt = build_expansion_prompt(
        title="기존 제목",
        body="기존 본문" * 100,
        keyword="핵심 키워드",
        target_chars=2500,
    )

    assert "바로 이어 붙일 추가 본문" in prompt
    assert "반복·요약하지 말고" in prompt
    assert "새로운 사실, 숫자, 가격, 정책, 개인 경험을 지어내지 마세요" in prompt
