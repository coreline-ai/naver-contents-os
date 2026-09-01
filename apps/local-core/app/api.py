from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth import require_token

router = APIRouter(prefix="/v1", dependencies=[Depends(require_token)])


@router.get("/handshake")
def handshake() -> dict:
    return {"status": "ok"}
