"""Launcher regression: incompatible live servers are never reused or killed."""
from __future__ import annotations

import importlib.util
import io
import json
import sqlite3
import subprocess
import urllib.error
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


@pytest.mark.parametrize("payload", [None, [], "foreign-server"])
def test_non_object_version_response_refuses_pairing(launcher, monkeypatch, capsys, payload):
    module, _ = launcher
    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: SimpleNamespace(
        open=lambda *_a, **_kw: io.StringIO(json.dumps(payload)),
    ))
    monkeypatch.setattr(module, "sessions", lambda *_a: pytest.fail("must not pair with a foreign response"))
    assert module.main() == 1
    assert "서버" in capsys.readouterr().err


def test_pair_only_with_stopped_server_does_not_start_or_issue_code(launcher, monkeypatch, capsys):
    module, _ = launcher

    def unavailable(*_a, **_kw):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=unavailable))
    monkeypatch.setattr(module, "sessions", lambda *_a: pytest.fail("no pairing before server readiness"))
    assert module.main() == 1
    assert "서버가 실행 중이 아닙니다" in capsys.readouterr().err


def test_foreign_http_server_is_never_replaced(launcher, monkeypatch, capsys):
    module, _ = launcher
    monkeypatch.setattr(module.sys, "argv", ["start_web_app.py", "--no-open"])

    def foreign(url, **_kw):
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=foreign))
    monkeypatch.setattr(module, "sessions", lambda *_a: pytest.fail("no pairing with foreign server"))
    assert module.main() == 1
    assert "호환되지 않는 서버" in capsys.readouterr().err


def test_missing_build_does_not_probe_or_launch(launcher, monkeypatch, capsys):
    module, settings = launcher
    (settings.web_build_dir / "index.html").unlink()
    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: pytest.fail("build must exist first"))
    assert module.main() == 1
    assert "pnpm build:web" in capsys.readouterr().err


def stopped_launcher(launcher, monkeypatch, process):
    module, _ = launcher
    monkeypatch.setattr(module.sys, "argv", ["start_web_app.py", "--no-open"])
    monkeypatch.setattr(module.subprocess, "Popen", lambda *_a, **_kw: process)
    monkeypatch.setattr(module.time, "sleep", lambda *_a: None)

    def unavailable(*_a, **_kw):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=unavailable))
    monkeypatch.setattr(module, "sessions", lambda *_a: pytest.fail("must not issue code before ready"))
    return module


def test_failed_child_never_issues_code_or_terminates_other_process(launcher, monkeypatch, capsys):
    process = SimpleNamespace(poll=lambda: 1, terminate=lambda: pytest.fail("exited child must not be signalled"))
    module = stopped_launcher(launcher, monkeypatch, process)
    assert module.main() == 1
    assert "앱 서버를 시작하지 못했습니다" in capsys.readouterr().err


@pytest.mark.parametrize("termination_timeout", [False, True])
def test_startup_timeout_only_terminates_its_own_child(launcher, monkeypatch, capsys, termination_timeout):
    calls = []

    def wait(*, timeout):
        calls.append(("wait", timeout))
        if termination_timeout:
            raise subprocess.TimeoutExpired("synthetic-owned-child", timeout)

    process = SimpleNamespace(poll=lambda: None, terminate=lambda: calls.append("terminate"), wait=wait)
    module = stopped_launcher(launcher, monkeypatch, process)
    assert module.main() == 1
    assert calls == ["terminate", ("wait", 10)]
    error = capsys.readouterr().err
    assert "서버 시작 확인 시간이 초과" in error
    assert ("강제 종료하지 않았습니다" in error) is termination_timeout


def test_startup_backs_up_content_before_launch_and_preserves_original(launcher, monkeypatch):
    module, settings = launcher
    with sqlite3.connect(settings.db_path) as db:
        db.execute("CREATE TABLE fixture (value TEXT)")
        db.execute("INSERT INTO fixture VALUES ('preserved')")
    polls = iter([False, True])

    def response(*_a, **_kw):
        if not next(polls):
            raise urllib.error.URLError("connection refused")
        return io.StringIO(json.dumps({"protocol": 1, "revision": module.runtime_revision()}))

    state = {"returncode": None, "waited": False}

    def wait():
        state.update(returncode=0, waited=True)

    def launch(*args, **_kw):
        backups = list((settings.db_path.parent / "backups").glob("*.db"))
        assert len(backups) == 1
        assert backups[0].stat().st_mode & 0o777 == 0o600
        with sqlite3.connect(backups[0]) as db:
            assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert db.execute("SELECT value FROM fixture").fetchone()[0] == "preserved"
        assert args[0][-2:] == ["--port", str(settings.local_core_port)]
        return SimpleNamespace(poll=lambda: state["returncode"], wait=wait)

    monkeypatch.setattr(module.sys, "argv", ["start_web_app.py", "--no-open"])
    monkeypatch.setattr(module.urllib.request, "build_opener", lambda *_a: SimpleNamespace(open=response))
    monkeypatch.setattr(module.subprocess, "Popen", launch)
    monkeypatch.setattr(module, "sessions", lambda *_a: SimpleNamespace(issue_code=lambda: "synthetic-pair-code"))
    assert module.main() == 0
    assert state["waited"]
    with sqlite3.connect(settings.db_path) as db:
        assert db.execute("SELECT value FROM fixture").fetchall() == [("preserved",)]
