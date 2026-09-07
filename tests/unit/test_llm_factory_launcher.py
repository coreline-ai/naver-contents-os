from types import SimpleNamespace

import pytest

from providers.llm.base import LLMError
from providers.llm.codex_cli import CodexCliProvider
from providers.llm.factory import build_llm_provider
from providers.llm.ollama import OllamaProvider
from providers.llm.openai_compat import OpenAICompatProvider


def make_settings(tmp_path, **overrides):
    defaults = dict(
        llm_provider="local",
        ollama_base_url="http://127.0.0.1:11434",
        ollama_model="",
        codex_cli_executable="codex",
        codex_cli_model="gpt-5.6-sol",
        codex_cli_reasoning="high",
        codex_cli_timeout_seconds=300.0,
        openai_compat_base_url="http://127.0.0.1:8787/v1",
        openai_compat_api_key="",
        openai_compat_model="",
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_factory_local_builds_ollama(tmp_path):
    provider = build_llm_provider(make_settings(tmp_path))
    assert isinstance(provider, OllamaProvider)


def test_factory_openai_compat_builds_provider_without_autostart(tmp_path):
    provider = build_llm_provider(make_settings(tmp_path, llm_provider="openai_compat"))
    assert isinstance(provider, OpenAICompatProvider)


def test_factory_codex_cli_builds_official_cli_provider(tmp_path):
    provider = build_llm_provider(make_settings(tmp_path, llm_provider="codex_cli"))
    assert isinstance(provider, CodexCliProvider)
    assert provider.model_name == "gpt-5.6-sol"


def test_factory_unknown_provider_raises(tmp_path):
    with pytest.raises(LLMError, match="지원하지 않는"):
        build_llm_provider(make_settings(tmp_path, llm_provider="mystery"))


def test_config_defaults_match_plan():
    from app.config import Settings

    settings = Settings(_env_file=None)
    assert settings.llm_provider == "local"  # external transfer stays opt-in
    assert settings.openai_compat_base_url == "http://127.0.0.1:8787/v1"
    assert settings.codex_cli_model == "gpt-5.6-sol"
    assert settings.codex_cli_reasoning == "high"
    summary = settings.status_summary()
    assert summary["openai_compat"] == "inactive"
    assert Settings(_env_file=None, llm_provider="openai_compat").status_summary()["openai_compat"] == "manual"


def test_deps_maps_factory_failure_to_llm_unavailable(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("LLM_PROVIDER", "mystery")
    from app import deps, errors

    deps.reset_caches()
    try:
        with pytest.raises(errors.LLMUnavailableError) as exc:
            deps.get_draft_service(use_llm=True)
        assert exc.value.provider == "mystery"
        assert deps.get_draft_service(use_llm=False) is not None  # skeleton path unaffected
    finally:
        deps.reset_caches()
