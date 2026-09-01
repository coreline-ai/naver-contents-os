"""Settings loader. Secrets live only in .env at the repo root; never log their values."""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[3]
DATA_DIR = ROOT_DIR / "data"
TOKEN_FILE = DATA_DIR / "local_core_token.txt"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    naver_hub_client_id: str = ""
    naver_hub_client_secret: str = ""
    naver_searchad_api_key: str = ""
    naver_searchad_secret_key: str = ""
    naver_searchad_customer_id: str = ""

    llm_provider: str = "local"
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = ""

    local_core_host: str = "127.0.0.1"
    local_core_port: int = 3719
    local_core_token: str = ""

    # Self-imposed monthly call limits, deliberately below official quotas (docs/10).
    # Official quotas change; treat the console as the source of truth.
    hub_search_monthly_limit: int = 50_000
    hub_trend_monthly_limit: int = 5_000
    searchad_monthly_limit: int = 10_000
    usage_warn_ratio: float = 0.8

    db_path: Path = DATA_DIR / "ncos.db"

    @property
    def hub_configured(self) -> bool:
        return bool(self.naver_hub_client_id and self.naver_hub_client_secret)

    @property
    def searchad_configured(self) -> bool:
        return bool(
            self.naver_searchad_api_key
            and self.naver_searchad_secret_key
            and self.naver_searchad_customer_id
        )

    def resolve_token(self) -> str:
        """LOCAL_CORE_TOKEN from .env, or a generated one persisted under data/."""
        if self.local_core_token:
            return self.local_core_token
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if TOKEN_FILE.exists():
            stored = TOKEN_FILE.read_text(encoding="utf-8").strip()
            if stored:
                return stored
        token = secrets.token_urlsafe(32)
        TOKEN_FILE.write_text(token + "\n", encoding="utf-8")
        return token

    def status_summary(self) -> dict[str, str]:
        """Configuration state without values: safe to log and to return from /health."""
        return {
            "naver_hub": "set" if self.hub_configured else "missing",
            "naver_searchad": "set" if self.searchad_configured else "missing",
            "llm_provider": self.llm_provider or "missing",
            "local_core_token": "set" if (self.local_core_token or TOKEN_FILE.exists()) else "generated-on-start",
        }


@lru_cache
def get_settings() -> Settings:
    return Settings()
