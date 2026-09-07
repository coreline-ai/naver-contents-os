"""Loopback-only browser sessions; pairing codes are issued by the local CLI.

Only credential digests are persisted, separately from the content database.
No HTTP route can issue a pairing code or return the extension's long token.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.config import Settings, get_settings

COOKIE = "ncos_web_session"
SESSION_TTL = 8 * 60 * 60
CODE_TTL = 5 * 60


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class WebSessions:
    def __init__(self, path: Path, origin: str):
        self.path = path
        self.origin = origin

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # O_NOFOLLOW also rejects a pre-existing symlink to an unrelated file.
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        os.close(fd)
        conn = sqlite3.connect(self.path, timeout=5)
        conn.execute("CREATE TABLE IF NOT EXISTS credentials (digest TEXT PRIMARY KEY, kind TEXT NOT NULL, origin TEXT NOT NULL, expires REAL NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS attempts (origin TEXT PRIMARY KEY, started REAL NOT NULL, count INTEGER NOT NULL)")
        conn.commit()
        return conn

    def issue_code(self) -> str:
        """Local-process operation only. Intentionally not exposed by an API."""
        code = secrets.token_urlsafe(32)
        with closing(self._connect()) as conn, conn:
            conn.execute("DELETE FROM credentials WHERE expires <= ?", (time.time(),))
            conn.execute("INSERT INTO credentials VALUES (?, 'code', ?, ?)", (_digest(code), self.origin, time.time() + CODE_TTL))
        return code

    def exchange(self, code: str) -> str:
        now = time.time()
        token = secrets.token_urlsafe(32)
        error = None
        with closing(self._connect()) as conn, conn:
            # Serialize consume + insert across threads AND launcher processes.
            conn.execute("BEGIN IMMEDIATE")
            attempts = conn.execute("SELECT started, count FROM attempts WHERE origin=?", (self.origin,)).fetchone()
            if attempts and now - attempts[0] < 60 and attempts[1] >= 5:
                error = (429, "pairing_rate_limit", "연결 시도가 많습니다. 1분 후 다시 시도하세요.")
            else:
                count = attempts[1] + 1 if attempts and now - attempts[0] < 60 else 1
                started = attempts[0] if count > 1 else now
                conn.execute("INSERT OR REPLACE INTO attempts VALUES (?, ?, ?)", (self.origin, started, count))
                found = conn.execute("DELETE FROM credentials WHERE digest=? AND kind='code' AND origin=? AND expires>? RETURNING digest", (_digest(code), self.origin, now)).fetchone()
                if found:
                    conn.execute("INSERT INTO credentials VALUES (?, 'session', ?, ?)", (_digest(token), self.origin, now + SESSION_TTL))
                    conn.execute("DELETE FROM attempts WHERE origin=?", (self.origin,))
                else:
                    error = (401, "pairing_expired", "연결 코드가 만료되었거나 이미 사용되었습니다. 실행기에서 새 코드를 발급하세요.")
        if error:
            raise HTTPException(error[0], detail={"code": error[1], "message": error[2]})
        return token

    def valid(self, token: str) -> bool:
        if not token or len(token) > 128 or not self.path.exists():
            return False
        with closing(self._connect()) as conn:
            return conn.execute("SELECT 1 FROM credentials WHERE digest=? AND kind='session' AND origin=? AND expires>?", (_digest(token), self.origin, time.time())).fetchone() is not None

    def revoke(self, token: str) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute("DELETE FROM credentials WHERE digest=? AND kind='session' AND origin=?", (_digest(token), self.origin))


def sessions(settings: Settings | None = None) -> WebSessions:
    settings = settings or get_settings()
    return WebSessions(settings.web_auth_path, settings.web_origin)


def check_web_request(request: Request, *, mutating: bool = False) -> None:
    expected = get_settings().web_origin
    if request.headers.get("host") != expected.removeprefix("http://"):
        raise HTTPException(403, detail={"code": "web_host", "message": "127.0.0.1 앱 주소로 접속하세요."})
    origin = request.headers.get("origin")
    if origin is not None and origin != expected:
        raise HTTPException(403, detail={"code": "web_origin", "message": "다른 사이트의 요청은 허용하지 않습니다."})
    if request.headers.get("sec-fetch-site") not in (None, "same-origin", "none"):
        raise HTTPException(403, detail={"code": "web_origin", "message": "앱에서 직접 실행하세요."})
    if mutating and (origin != expected or request.headers.get("x-ncos-web") != "1"):
        raise HTTPException(403, detail={"code": "web_csrf", "message": "앱 화면에서 다시 시도하세요."})


def require_web_session(request: Request) -> None:
    check_web_request(request, mutating=request.method not in ("GET", "HEAD", "OPTIONS"))
    if not sessions().valid(request.cookies.get(COOKIE, "")):
        raise HTTPException(401, detail={"code": "web_session", "message": "앱 연결이 필요합니다. 실행기에서 새 연결 코드를 발급하세요."})


router = APIRouter(prefix="/web")


class ConnectRequest(BaseModel):
    code: str = Field(min_length=16, max_length=128)


@router.get("/session")
def session_status(request: Request, response: Response) -> dict:
    check_web_request(request)
    response.headers["Cache-Control"] = "no-store"
    return {"connected": sessions().valid(request.cookies.get(COOKIE, "")), "mode": "live"}


@router.post("/session/connect")
def connect_session(body: ConnectRequest, request: Request, response: Response) -> dict:
    check_web_request(request, mutating=True)
    store = sessions()
    token = store.exchange(body.code)
    # Rotate this browser's previous session without affecting another browser.
    store.revoke(request.cookies.get(COOKIE, ""))
    response.set_cookie(COOKIE, token, max_age=SESSION_TTL, httponly=True, samesite="strict", path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"connected": True, "mode": "live"}


@router.delete("/session", status_code=204)
def disconnect_session(request: Request, response: Response) -> None:
    check_web_request(request, mutating=True)
    sessions().revoke(request.cookies.get(COOKIE, ""))
    response.delete_cookie(COOKIE, path="/", httponly=True, samesite="strict")
    response.headers["Cache-Control"] = "no-store"
