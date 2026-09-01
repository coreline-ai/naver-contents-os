from __future__ import annotations

from enum import StrEnum


class BlogType(StrEnum):
    HOWTO = "HOWTO"
    POLICY = "POLICY"
    COMPARISON = "COMPARISON"
    REVIEW = "REVIEW"
    HOMEFEED = "HOMEFEED"
    PRODUCT = "PRODUCT"
    NEWS = "NEWS"
    SERIES = "SERIES"
