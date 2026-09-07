from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, Request

from app.config import get_settings

_HEADER = "X-Local-Token"


def require_token(request: Request, x_local_token: str = Header(default="", alias=_HEADER)) -> None:
    if not x_local_token:
        from app.web_session import COOKIE, require_web_session

        if request.cookies.get(COOKIE):
            require_web_session(request)
            return
    expected = get_settings().resolve_token()
    if not x_local_token or not secrets.compare_digest(x_local_token, expected):
        raise HTTPException(status_code=401, detail={"code": "auth", "message": "invalid local token"})
