"""Launcher regression: incompatible live servers are never reused or killed."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.config import Settings
from app import web_version


@pytest.fixture
def launcher(monkeypatch, tmp_path):
    path = Path(__file__).resolve().parents[2] / "scripts/start_web_app.py"
    spec = importlib.util.spec_from_file_location("ncos_launcher_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    build = tmp_path / "web"
    build.mkdir()
    (build / "index.html").write_text("<html>isolated</html>")
    settings = Settings(_env_file=None, web_build_dir=build, db_path=tmp_path / "content.db")
    monkeypatch.setattr(module, "get_settings", lambda: settings)
    monkeypatch.setattr(web_version, "get_settings", lambda: settings)
    monkeypatch.setattr(web_version, "ROOT_DIR", tmp_path)
    monkeypatch.setattr(module.sys, "argv", ["start_web_app.py", "--pair-only", "--no-open"])
    monkeypatch.setattr(module.subprocess, "Popen", lambda *_a, **_kw: pytest.fail("must not start or terminate any server"))
    monkeypatch.setattr(module.webbrowser, "open", lambda *_a: pytest.fail("must not open a browser"))
    return module, settings


def respond(monkeypatch, module, revision, protocol=1):
    def open_response(url, timeout):
        assert url.endswith("/web/version") and timeout == 2
        return io.StringIO(json.dumps({"protocol": protocol, "revision": revision}))
    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=open_response))


def test_provider_change_refuses_old_server_before_pair_code(launcher, monkeypatch, capsys):
    module, settings = launcher
    old_revision = module.runtime_revision()
    settings.llm_provider = "codex_cli"
    settings.codex_cli_model = "synthetic-new-model"
    respond(monkeypatch, module, old_revision)
    monkeypatch.setattr(module, "sessions", lambda *_a: pytest.fail("old server must not get a new pairing code"))
    assert module.main() == 1
    assert "구버전 서버" in capsys.readouterr().err


def test_same_effective_server_can_be_paired_without_start_or_browser(launcher, monkeypatch, capsys):
    module, _ = launcher
    respond(monkeypatch, module, module.runtime_revision())
    monkeypatch.setattr(module, "sessions", lambda *_a: SimpleNamespace(issue_code=lambda: "synthetic-pair-code"))
    assert module.main() == 0
    assert "synthetic-pair-code" in capsys.readouterr().out


def test_unknown_protocol_refuses_reuse(launcher, monkeypatch):
    module, _ = launcher
    respond(monkeypatch, module, module.runtime_revision(), protocol=99)
    monkeypatch.setattr(module, "sessions", lambda *_a: pytest.fail("unsupported protocol"))
    assert module.main() == 1
