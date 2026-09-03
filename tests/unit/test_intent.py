from intelligence.keyword.intent import classify_intent


def test_intent_v1_markers_and_priority():
    assert classify_intent("지원금 신청 승인 조건")["intent"] == "eligibility"
    assert classify_intent("승인 보류 해결 방법")["intent"] == "troubleshooting"
    assert classify_intent("블로그 수익 광고")["intent"] == "commercial"
    assert classify_intent("제품 비교 후기")["intent"] == "comparison_review"
    assert classify_intent("성수 지역 맛집")["intent"] == "local_visit"
    assert classify_intent("초기 설정 방법")["intent"] == "howto"
    assert classify_intent("용어 뜻 정리")["intent"] == "informational"


def test_intent_normalizes_nfkc_spaces_and_keeps_other():
    classified = classify_intent("  ＶＳ　비교  ")
    assert classified["normalized_keyword"] == "VS 비교"
    assert classified["intent"] == "comparison_review"
    assert classified["confidence"] == "high"
    assert classify_intent("완전히중립적인단어") == {
        "intent": "other",
        "intent_version": "intent-v1",
        "matched_markers": [],
        "confidence": "low",
        "normalized_keyword": "완전히중립적인단어",
    }
    assert classify_intent("　 ")["intent"] == "other"
