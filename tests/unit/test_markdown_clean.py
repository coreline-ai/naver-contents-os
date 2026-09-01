from publisher.markdown import clean_markdown


def test_strips_headings_bold_emphasis_backticks():
    text = "## 제목\n**굵게** 그리고 *기울임* 과 `코드` 입니다."
    assert clean_markdown(text) == "제목\n굵게 그리고 기울임 과 코드 입니다."


def test_links_keep_text_drop_url():
    assert clean_markdown("[네이버](https://naver.com)에서 확인") == "네이버에서 확인"


def test_code_fences_removed_and_newlines_collapsed():
    text = "첫 문단\n\n\n\n```python\nprint(1)\n```\n둘째 문단"
    out = clean_markdown(text)
    assert "```" not in out
    assert "\n\n\n" not in out
    assert "print(1)" in out  # content survives, fence markers do not


def test_bullets_normalized():
    assert clean_markdown("* 하나\n- 둘") == "- 하나\n- 둘"


def test_plain_text_unchanged():
    text = "일반 문장입니다. 3 * 4 계산식은 곱셈 기호가 아닌 문장 중 별표입니다."
    assert "일반 문장입니다." in clean_markdown(text)
