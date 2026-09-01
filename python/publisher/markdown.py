"""LLM output cleanup before SmartEditor input (docs/05): SmartEditor is not a
markdown editor, so heading/bold/code markers must be stripped, not rendered."""

from __future__ import annotations

import re

_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_EMPH_RE = re.compile(r"(?<!\*)\*([^*\n]+)\*(?!\*)")
_BULLET_RE = re.compile(r"^\s*[*\-]\s+", re.MULTILINE)
_CODEFENCE_RE = re.compile(r"^```[^\n]*$", re.MULTILINE)


def clean_markdown(text: str) -> str:
    out = text.replace("\r\n", "\n")
    out = _CODEFENCE_RE.sub("", out)
    out = out.replace("`", "")
    out = _LINK_RE.sub(r"\1", out)
    out = _HEADING_RE.sub("", out)
    out = _BOLD_RE.sub(r"\1", out)
    out = _EMPH_RE.sub(r"\1", out)
    out = _BULLET_RE.sub("- ", out)  # keep list feel with a plain dash
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()
