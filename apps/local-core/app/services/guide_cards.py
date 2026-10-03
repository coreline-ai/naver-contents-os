"""Locally rendered excerpts, not photographs or AI-generated illustrations."""
from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = (
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf",
    "C:/Windows/Fonts/malgun.ttf",
)


@dataclass(frozen=True)
class ExcerptCard:
    title: str
    excerpt: str
    anchor_after: int


def excerpt_cards(title: str, body: str, count: int = 3) -> list[ExcerptCard]:
    # Match the publisher: each non-empty source line is a native paragraph.
    paragraphs = [p.strip() for p in body.splitlines() if re.sub(r"[\s\u200b-\u200d\ufeff]", "", p)]
    candidates = [(index + 1, p) for index, p in enumerate(paragraphs)
                  if len(p) >= 40 and not p.startswith(("#", "http://", "https://", "!["))]
    if len(candidates) < count:
        raise ValueError(f"본문 발췌 카드를 만들려면 40자 이상인 설명 문단이 {count}개 필요합니다. 원고를 보완하거나 직접 촬영한 이미지를 추가하세요.")
    # Distributed, distinct source paragraphs. No invented labels/facts/diagrams.
    indices = [((i + 1) * len(candidates)) // (count + 1) for i in range(count)]
    return [ExcerptCard(title, candidates[i][1], candidates[i][0]) for i in indices]


def korean_font_path() -> str:
    override = os.environ.get("NCOS_GUIDE_FONT")
    paths = (override,) if override else FONT_PATHS
    for path in paths:
        if path and Path(path).is_file():
            try:
                font = ImageFont.truetype(path, 24)
                # Reject a common missing-glyph fallback rather than silently making tofu cards.
                if bytes(font.getmask("가")) != bytes(font.getmask("힣")):
                    return path
            except OSError:
                pass
    raise ValueError("한글 카드용 글꼴을 찾지 못했습니다. Noto Sans CJK를 설치하거나 NCOS_GUIDE_FONT에 사용 가능한 한글 TTF/TTC/OTF 경로를 설정하세요.")


def _lines(text: str, font: ImageFont.FreeTypeFont, width: int, limit: int) -> list[str]:
    """Pixel-measured wrapping, with explicit ellipsis when an excerpt is cut."""
    text = " ".join(text.split())
    lines: list[str] = []
    line = ""
    for char in text:
        if font.getlength(line + char) > width:
            if len(lines) == limit - 1:
                while line and font.getlength(line + "…") > width:
                    line = line[:-1]
                lines.append(line.rstrip() + "…")
                return lines
            lines.append(line.rstrip())
            line = char.lstrip()
        else:
            line += char
    if line:
        lines.append(line)
    return lines


def render_card(card: ExcerptCard, ordinal: int, font_path: str) -> bytes:
    image = Image.new("RGB", (1200, 900), "#F4F7F5")
    draw = ImageDraw.Draw(image)
    small = ImageFont.truetype(font_path, 26)
    heading = ImageFont.truetype(font_path, 43)
    body = ImageFont.truetype(font_path, 36)
    draw.rectangle((0, 0, 1200, 14), fill="#107B5E")
    draw.text((72, 54), f"본문 발췌  /  {ordinal:02d}", font=small, fill="#107B5E")
    for i, line in enumerate(_lines(card.title, heading, 1056, 2)):
        draw.text((72, 115 + i * 58), line, font=heading, fill="#162D26")
    draw.rounded_rectangle((54, 260, 1146, 764), radius=24, fill="white")
    for i, line in enumerate(_lines(card.excerpt, body, 1008, 9)):
        draw.text((96, 288 + i * 49), line, font=body, fill="#21382F")
    draw.text((72, 811), f"원고 {card.anchor_after}번째 문단에서 발췌 · 사진이 아닌 텍스트 카드", font=small, fill="#496457")
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()
