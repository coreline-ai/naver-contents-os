"""Startup must not reuse a server with a different effective AI configuration."""
from __future__ import annotations

import pytest

from app.config import Settings
from app import web_version


@pytest.fixture
def settings(monkeypatch, tmp_path):
    value = Settings(_env_file=None, db_path=tmp_path / "test.sqlite", web_build_dir=tmp_path / "web")
    monkeypatch.setattr(web_version, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(web_version, "get_settings", lambda: value)
    return value


@pytest.mark.parametrize("key,value", [
    ("llm_provider", "codex_cli"),
    ("ollama_base_url", "http://127.0.0.1:11435"),
    ("ollama_model", "test-local-model"),
    ("codex_cli_model", "test-codex-model"),
    ("codex_cli_reasoning", "medium"),
    ("codex_cli_timeout_seconds", 120.0),
    ("openai_compat_base_url", "http://127.0.0.1:8788/v1"),
    ("openai_compat_model", "test-remote-model"),
    ("publisher_cdp_url", "http://127.0.0.1:9223"),
    ("hub_search_daily_limit", 50),
])
def test_effective_setting_change_invalidates_revision(settings, key, value):
    before = web_version.runtime_revision()
    setattr(settings, key, value)
    assert web_version.runtime_revision() != before


def test_revision_stable_for_same_settings(settings):
    assert web_version.runtime_revision() == web_version.runtime_revision()


def test_revision_never_fingerprints_secret_values(settings):
    settings.openai_compat_api_key = "synthetic-key-a"
    before = web_version.runtime_revision()
    settings.openai_compat_api_key = "synthetic-key-b"
    assert web_version.runtime_revision() == before
    settings.openai_compat_api_key = ""
    assert web_version.runtime_revision() != before


def test_source_and_build_changes_invalidate_revision(settings, tmp_path):
    source = tmp_path / "apps/local-core/app/example.py"
    source.parent.mkdir(parents=True)
    source.write_text("value = 1\n")
    before = web_version.runtime_revision()
    source.write_text("value = 2\n")
    assert web_version.runtime_revision() != before
    settings.web_build_dir.mkdir()
    index = settings.web_build_dir / "index.html"
    before = web_version.runtime_revision()
    index.write_text("<html>isolated fixture</html>")
    assert web_version.runtime_revision() != before
