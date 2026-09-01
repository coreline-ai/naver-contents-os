from types import SimpleNamespace

import pytest

from providers.llm.base import LLMError
from providers.llm.factory import build_llm_provider
from providers.llm.ollama import OllamaProvider
from providers.llm.openai_compat import OpenAICompatProvider
from providers.llm.proxy_launcher import ensure_codex_proxy


def make_settings(tmp_path, **overrides):
    auth = tmp_path / "auth.json"
    auth.write_text("{}", encoding="utf-8")
    defaults = dict(
        llm_provider="local",
        ollama_base_url="http://127.0.0.1:11434",
        ollama_model="",
        openai_compat_base_url="http://127.0.0.1:8787/v1",
        openai_compat_api_key="",
        openai_compat_model="",
        codex_proxy_autostart=False,
        codex_proxy_cmd="fake-proxy --port 8787",
        codex_auth_file=auth,
    )
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_factory_local_builds_ollama(tmp_path):
    provider = build_llm_provider(make_settings(tmp_path))
    assert isinstance(provider, OllamaProvider)


def test_factory_openai_compat_builds_provider_without_autostart(tmp_path):
    provider = build_llm_provider(make_settings(tmp_path, llm_provider="openai_compat"))
    assert isinstance(provider, OpenAICompatProvider)


def test_factory_unknown_provider_raises(tmp_path):
    with pytest.raises(LLMError, match="지원하지 않는"):
        build_llm_provider(make_settings(tmp_path, llm_provider="mystery"))


def test_config_defaults_match_plan():
    from app.config import Settings

    settings = Settings(_env_file=None)
    assert settings.llm_provider == "local"  # external transfer stays opt-in
    assert settings.openai_compat_base_url == "http://127.0.0.1:8787/v1"
    assert settings.codex_proxy_autostart is False
    assert "codex-openai-proxy" in settings.codex_proxy_cmd
    summary = settings.status_summary()
    assert summary["openai_compat"] == "inactive"
    assert Settings(_env_file=None, llm_provider="openai_compat").status_summary()["openai_compat"] == "manual"


class FakeProcess:
    def __init__(self, exits_immediately=False):
        self.exits_immediately = exits_immediately
        self.returncode = 1 if exits_immediately else None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.killed = True


def test_launcher_reuses_running_proxy(tmp_path):
    settings = make_settings(tmp_path)
    started = []
    handle = ensure_codex_proxy(
        settings, popen=lambda *a, **k: started.append(a) or FakeProcess(), probe_fn=lambda _u: True
    )
    assert handle is None
    assert started == []  # never spawned


def test_launcher_starts_and_waits_until_healthy(tmp_path):
    settings = make_settings(tmp_path)
    probes = iter([False, False, True])
    process = FakeProcess()
    handle = ensure_codex_proxy(
        settings,
        popen=lambda *a, **k: process,
        probe_fn=lambda _u: next(probes),
        sleeper=lambda _s: None,
    )
    assert handle is not None and handle.process is process
    assert not process.terminated


def test_launcher_missing_auth_file_mentions_codex_login(tmp_path):
    settings = make_settings(tmp_path, codex_auth_file=tmp_path / "missing.json")
    with pytest.raises(LLMError, match="codex login"):
        ensure_codex_proxy(settings, popen=lambda *a, **k: FakeProcess(), probe_fn=lambda _u: False)


def test_launcher_immediate_exit_is_reported(tmp_path):
    settings = make_settings(tmp_path)
    with pytest.raises(LLMError, match="종료"):
        ensure_codex_proxy(
            settings,
            popen=lambda *a, **k: FakeProcess(exits_immediately=True),
            probe_fn=lambda _u: False,
            sleeper=lambda _s: None,
        )


def test_launcher_timeout_terminates_child(tmp_path):
    settings = make_settings(tmp_path)
    process = FakeProcess()
    with pytest.raises(LLMError, match="준비되지 않았습니다"):
        ensure_codex_proxy(
            settings,
            popen=lambda *a, **k: process,
            probe_fn=lambda _u: False,
            sleeper=lambda _s: None,
            timeout_seconds=1.0,
        )
    assert process.terminated


def test_deps_maps_factory_failure_to_llm_unavailable(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "t.db"))
    monkeypatch.setenv("LLM_PROVIDER", "mystery")
    from app import deps, errors

    deps.reset_caches()
    try:
        with pytest.raises(errors.LLMUnavailableError):
            deps.get_draft_service(use_llm=True)
        assert deps.get_draft_service(use_llm=False) is not None  # skeleton path unaffected
    finally:
        deps.reset_caches()
