"""Normalization helpers for scoring. Missing data stays missing — never coerced to 0 (docs/03)."""

from __future__ import annotations

import math
import re
import unicodedata
from datetime import date, datetime

_TAG_RE = re.compile(r"</?b>|</?strong>", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def clean_title(text: str) -> str:
    """Strip the <b> highlight tags Naver puts around matched terms."""
    return _WS_RE.sub(" ", _TAG_RE.sub("", text)).strip()


def normalize_keyword(text: str) -> str:
    """NFKC + collapsed whitespace form used at every keyword input boundary."""
    return _WS_RE.sub(" ", unicodedata.normalize("NFKC", text)).strip()


def compact(text: str) -> str:
    """Space-insensitive, casefolded form for keyword comparison."""
    return _WS_RE.sub("", unicodedata.normalize("NFKC", text)).casefold()


def log1p_norm(value: float | None, reference_max: float) -> float | None:
    """log1p-scaled 0..1 against a fixed reference (part of the score version)."""
    if value is None or value < 0:
        return None
    return min(1.0, math.log1p(value) / math.log1p(reference_max))


_DATE_PATTERNS = (
    ("%Y%m%d", re.compile(r"^\d{8}$")),
    ("%Y.%m.%d", re.compile(r"^\d{4}\.\d{1,2}\.\d{1,2}\.?$")),
    ("%Y-%m-%d", re.compile(r"^\d{4}-\d{2}-\d{2}")),
)


def parse_posted_date(raw: str) -> date | None:
    text = raw.strip().rstrip(".")
    for fmt, pattern in _DATE_PATTERNS:
        if pattern.match(text if fmt != "%Y.%m.%d" else raw.strip()):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                continue
    # RFC822 pubDate (news): "Tue, 01 Sep 2026 21:10:11 +0900"
    try:
        return datetime.strptime(raw.strip()[:16], "%a, %d %b %Y").date()
    except ValueError:
        return None


def trend_change(ratios: list[float], window: int = 3) -> float | None:
    """Relative change of the recent window vs the one before it. None if too short."""
    if len(ratios) < window * 2:
        return None
    recent = sum(ratios[-window:]) / window
    previous = sum(ratios[-window * 2 : -window]) / window
    if previous <= 0:
        return None if recent <= 0 else 1.0
    return max(-1.0, min(1.0, (recent - previous) / previous))
