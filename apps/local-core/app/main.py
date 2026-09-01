from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.errors import CoreError
from app.logging import configure_logging, get_logger

# Chrome/Whale extension IDs are 32 chars of a-p.
EXTENSION_ORIGIN_REGEX = r"^chrome-extension://[a-p]{32}$"


def create_app() -> FastAPI:
    configure_logging()
    log = get_logger("app")
    settings = get_settings()
    settings.resolve_token()  # Create the pairing token before the extension first connects.

    from app.migrate import upgrade_to_head

    upgrade_to_head()

    app = FastAPI(title="Naver Content OS - Local Core", version="0.1.0", docs_url=None, redoc_url=None)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=EXTENSION_ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(CoreError)
    async def core_error_handler(_request: Request, exc: CoreError) -> JSONResponse:
        return JSONResponse(status_code=exc.http_status, content={"error": exc.payload()})

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "version": app.version, "config": settings.status_summary()}

    from app.api import router as v1_router

    app.include_router(v1_router)

    log.info("app_configured", **settings.status_summary())
    return app


app = create_app()
