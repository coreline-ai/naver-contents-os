"""Non-secret runtime fingerprint, frozen by main.create_app at startup."""
import hashlib
import json
from app.config import ROOT_DIR, get_settings


# Only effective, non-credential settings contribute to the public revision.
# In particular, do not expose a reusable digest of API keys or session tokens.
RUNTIME_SETTINGS = (
    "llm_provider", "ollama_base_url", "ollama_model",
    "codex_cli_executable", "codex_cli_model", "codex_cli_reasoning",
    "codex_cli_timeout_seconds", "openai_compat_base_url", "openai_compat_model",
    "local_core_host", "local_core_port", "publisher_cdp_url",
    "hub_search_monthly_limit", "hub_search_daily_limit", "hub_search_rps",
    "hub_trend_monthly_limit", "hub_trend_daily_limit", "hub_trend_rps",
    "hub_shopping_monthly_limit", "hub_shopping_daily_limit", "hub_shopping_rps",
    "searchad_monthly_limit", "searchad_daily_limit", "searchad_rps", "usage_warn_ratio",
)


def runtime_revision() -> str:
    digest = hashlib.sha256()
    settings = get_settings()
    digest.update(f"{settings.db_path.resolve()}|{settings.web_origin}|{settings.web_build_dir.resolve()}".encode())
    effective = {key: getattr(settings, key) for key in RUNTIME_SETTINGS}
    # Empty -> configured also changes readiness. Credential values themselves
    # deliberately remain outside the fingerprint; rotating one needs restart.
    effective["credentials_configured"] = {
        key: bool(getattr(settings, key)) for key in (
            "naver_hub_client_id", "naver_hub_client_secret", "naver_searchad_api_key",
            "naver_searchad_secret_key", "naver_searchad_customer_id", "openai_compat_api_key",
        )
    }
    digest.update(json.dumps(effective, sort_keys=True, separators=(",", ":")).encode())
    paths = [*ROOT_DIR.joinpath('apps/local-core/app').rglob('*.py'), *ROOT_DIR.joinpath('python').rglob('*.py'), *ROOT_DIR.joinpath('alembic/versions').glob('*.py')]
    paths += [settings.web_build_dir / 'index.html', settings.web_build_dir / 'theme-init.js']
    for path in sorted(paths):
        if path.is_file():
            digest.update(str(path.relative_to(ROOT_DIR) if path.is_relative_to(ROOT_DIR) else path.name).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:20]
