from __future__ import annotations

import secrets

from fastapi import Header, HTTPException

from app.config import get_settings

_HEADER = "X-Local-Token"


def require_token(x_local_token: str = Header(default="", alias=_HEADER)) -> None:
    expected = get_settings().resolve_token()
    if not x_local_token or not secrets.compare_digest(x_local_token, expected):
        raise HTTPException(status_code=401, detail={"code": "auth", "message": "invalid local token"})
