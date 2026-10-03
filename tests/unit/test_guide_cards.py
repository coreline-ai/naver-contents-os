import io

import pytest
from PIL import Image, ImageFont

from app.services import guide_cards


def test_cards_are_exact_source_excerpts_with_original_line_anchors():
    paragraphs = [f"설명 {i}: " + "원고에 실제로 있는 정보만 그대로 발췌합니다. " * 4 for i in range(6)]
    body = "제목\n\n" + "\n\n".join(paragraphs)
    cards = guide_cards.excerpt_cards("검수 카드", body)
    assert [c.anchor_after for c in cards] == [3, 5, 6]
    assert [c.excerpt for c in cards] == [paragraphs[i].strip() for i in [1, 3, 4]]


def test_short_body_does_not_get_fake_filler_cards():
    with pytest.raises(ValueError, match="설명 문단"):
        guide_cards.excerpt_cards("주제", "짧은 문장")


def test_missing_or_non_korean_override_fails_without_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("NCOS_GUIDE_FONT", str(tmp_path / "missing.ttf"))
    with pytest.raises(ValueError, match="한글 카드용 글꼴"):
        guide_cards.korean_font_path()
    font_path = tmp_path / "latin.ttf"
    font_path.write_bytes(ImageFont.load_default().font_bytes)
    monkeypatch.setenv("NCOS_GUIDE_FONT", str(font_path))
    with pytest.raises(ValueError, match="한글 카드용 글꼴"):
        guide_cards.korean_font_path()


def test_rendering_is_bounded_and_long_excerpt_is_explicitly_truncated(tmp_path):
    font_path = tmp_path / "fixture.ttf"
    font_path.write_bytes(ImageFont.load_default().font_bytes)
    font = ImageFont.truetype(str(font_path), 36)
    lines = guide_cards._lines("W" * 5000, font, 1008, 9)
    assert len(lines) == 9 and lines[-1].endswith("…")
    assert all(font.getlength(line) <= 1008 for line in lines)
    card = guide_cards.ExcerptCard("Long title " * 30, "Actual source excerpt " * 200, 3)
    data = guide_cards.render_card(card, 1, str(font_path))
    with Image.open(io.BytesIO(data)) as image:
        assert image.size == (1200, 900) and image.format == "PNG"
    assert data != guide_cards.render_card(guide_cards.ExcerptCard(card.title, "Different source text", 3), 1, str(font_path))
