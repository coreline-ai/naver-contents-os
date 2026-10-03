"""Serve only the built web directory; history fallback never covers /v1."""
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse

from app.web_session import check_web_request


def web_router(build_dir: Path) -> APIRouter:
    router = APIRouter()

    @router.get("/app", include_in_schema=False)
    def redirect_app(request: Request):
        check_web_request(request)
        return RedirectResponse("/app/")

    @router.get("/app/{path:path}", include_in_schema=False)
    def serve_app(path: str, request: Request):
        check_web_request(request)
        root = build_dir.resolve()
        target = (root / path).resolve()
        if not target.is_relative_to(root) or any(part.startswith(".") for part in Path(path).parts):
            raise HTTPException(404)
        index = (root / "index.html").resolve()
        if not index.is_relative_to(root):
            raise HTTPException(404)
        if not index.is_file():
            raise HTTPException(503, detail={"code": "web_build_missing", "message": "웹 빌드가 없습니다. pnpm build:web을 실행하세요."})
        if not target.is_file():
            # Known app routes only; missing JS/CSS must not become HTML 200.
            if path.rstrip("/") not in ("", "write", "keywords", "drafts", "performance", "settings"):
                raise HTTPException(404)
            target = index
        return FileResponse(target, headers={
            "Cache-Control": "public, max-age=31536000, immutable" if target.is_relative_to(root / "assets") else "no-cache",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        })

    return router
