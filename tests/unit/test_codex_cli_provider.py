from __future__ import annotations

import json
from pathlib import Path
import subprocess

import pytest

from providers.llm.base import LLMError
from providers.llm.codex_cli import (
    ARTICLE_SCHEMA,
    EXPANSION_SCHEMA,
    CodexCliProvider,
    _safe_environment,
)


class FakeProcess:
    next_pid = 990_000

    def __init__(self, *, stdout="", stderr="", returncode=0, timeout_once=False):
        self.stdout = stdout
        self.stderr = stderr
        self.final_returncode = returncode
        self.returncode = None
        self.timeout_once = timeout_once
        self.killed = False
        self.inputs: list[str] = []
        self.pid = FakeProcess.next_pid
        FakeProcess.next_pid += 1

    def communicate(self, input=None, timeout=None):
        self.inputs.append(input or "")
        if self.timeout_once and timeout is not None:
            self.timeout_once = False
            raise subprocess.TimeoutExpired("codex", timeout)
        self.returncode = self.final_returncode
        return self.stdout, self.stderr

    def poll(self):
        return self.returncode

    def kill(self):
        self.killed = True
        self.returncode = -9


class ProcessFactory:
    def __init__(self, *processes: FakeProcess):
        self.processes = list(processes)
        self.calls: list[tuple[list[str], dict]] = []

    def __call__(self, args, **kwargs):
        self.calls.append((list(args), kwargs))
        return self.processes.pop(0)


def article_payload(*, sections=2):
    return json.dumps(
        {
            "title": "처음 시작하는 안전한 블로그 글쓰기 방법",
            "sections": [
                {"heading": f"서로 다른 소제목 {index}", "content": f"구체적인 한국어 완성 문단 {index}입니다."}
                for index in range(sections)
            ],
            "tags": ["블로그글쓰기"],
            "fact_warnings": ["가격과 운영시간은 공식 안내에서 확인하세요."],
        },
        ensure_ascii=False,
    )


def provider(factory, **overrides):
    return CodexCliProvider(
        executable="codex",
        model=overrides.pop("model", "gpt-5.6-sol"),
        reasoning_effort=overrides.pop("reasoning_effort", "high"),
        timeout=overrides.pop("timeout", 30),
        popen_factory=factory,
        which_fn=lambda _name: "/usr/bin/true",
        environment=overrides.pop("environment", {}),
        **overrides,
    )


def test_article_generation_uses_official_cli_isolation_and_stdin():
    login = FakeProcess(stdout="Logged in using ChatGPT\n")
    generation = FakeProcess(stdout=article_payload())
    factory = ProcessFactory(login, generation)
    llm = provider(factory)

    result = llm.generate_article("주제: 안전한 여행 준비", system="한국어로 작성")

    assert result.startswith("제목: 처음 시작하는 안전한 블로그 글쓰기 방법")
    assert "발행 전 확인할 사항" in result
    assert llm.status_metadata == {
        "engine": "codex_cli",
        "auth": "chatgpt",
        "quality_tier": "high",
    }
    assert factory.calls[0][0][1:] == ["login", "status"]
    args, options = factory.calls[1]
    assert args[-1] == "-"
    assert "--ephemeral" in args
    assert ["--sandbox", "read-only"] == args[args.index("--sandbox") : args.index("--sandbox") + 2]
    assert "--ignore-user-config" in args
    assert "--ignore-rules" in args
    assert "--skip-git-repo-check" in args
    assert str(ARTICLE_SCHEMA) in args
    assert "안전한 여행 준비" not in " ".join(args)
    assert generation.inputs and "<source_data>" in generation.inputs[0]
    assert "안전한 여행 준비" in generation.inputs[0]
    assert options["env"] == {}
    assert Path(options["cwd"]).name.startswith("ncos-codex-writer-")
    assert options["start_new_session"] is True


def test_login_status_detects_chatgpt_when_cli_writes_to_stderr():
    llm = provider(ProcessFactory(FakeProcess(stderr="Logged in using ChatGPT\n")))

    assert llm.resolve_model() == "gpt-5.6-sol"
    assert llm.status_metadata["auth"] == "chatgpt"


def test_expansion_prompt_selects_smaller_schema():
    factory = ProcessFactory(
        FakeProcess(stdout="Logged in using ChatGPT\n"),
        FakeProcess(stdout=article_payload()),
    )
    llm = provider(factory)
    llm.generate_article("이어 붙일 추가 본문을 작성하세요")
    assert str(EXPANSION_SCHEMA) in factory.calls[1][0]


def test_safe_environment_does_not_forward_application_secrets():
    safe = _safe_environment(
        {
            "HOME": "/Users/test",
            "PATH": "/usr/bin",
            "CODEX_HOME": "/Users/test/.codex",
            "NAVER_HUB_CLIENT_SECRET": "do-not-forward",
            "OPENAI_API_KEY": "do-not-forward",
        }
    )
    assert safe == {
        "HOME": "/Users/test",
        "PATH": "/usr/bin",
        "CODEX_HOME": "/Users/test/.codex",
    }


def test_missing_cli_and_logged_out_status_have_actions():
    missing = CodexCliProvider(which_fn=lambda _name: None, environment={})
    with pytest.raises(LLMError, match="설치"):
        missing.resolve_model()

    logged_out = provider(ProcessFactory(FakeProcess(stderr="not logged in", returncode=1)))
    with pytest.raises(LLMError, match="codex login"):
        logged_out.resolve_model()
    assert logged_out.status_metadata["auth"] == "missing"


def test_timeout_kills_process_and_does_not_include_stderr():
    login = FakeProcess(stdout="Logged in using ChatGPT\n")
    generation = FakeProcess(timeout_once=True)
    llm = provider(ProcessFactory(login, generation), timeout=10)
    with pytest.raises(LLMError, match="10초"):
        llm.generate_article("주제: 시간 초과")
    assert generation.killed is True


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        ("HTTP 429 rate limit with secret-token", "사용량 한도"),
        ("HTTP 401 unauthorized secret-token", "codex login"),
        ("unexpected secret-token", "codex doctor"),
    ],
)
def test_failed_exit_is_classified_without_leaking_stderr(stderr, expected):
    factory = ProcessFactory(
        FakeProcess(stdout="Logged in using ChatGPT\n"),
        FakeProcess(stderr=stderr, returncode=1),
    )
    with pytest.raises(LLMError, match=expected) as exc:
        provider(factory).generate_article("주제: 오류 처리")
    assert "secret-token" not in str(exc.value)


@pytest.mark.parametrize(
    "raw",
    [
        "not-json",
        json.dumps({"title": "제목", "sections": [], "tags": [], "fact_warnings": []}),
        json.dumps({"title": "제목", "sections": [{"heading": "", "content": "본문"}]}),
    ],
)
def test_invalid_structured_article_is_rejected(raw):
    factory = ProcessFactory(
        FakeProcess(stdout="Logged in using ChatGPT\n"),
        FakeProcess(stdout=raw),
    )
    with pytest.raises(LLMError):
        provider(factory).generate_article("주제: JSON 검사")


def test_concurrent_generation_is_rejected_instead_of_queued():
    llm = provider(ProcessFactory())
    assert llm._semaphore.acquire(blocking=False)  # noqa: SLF001 - deliberate contention test
    try:
        with pytest.raises(LLMError, match="다른 Codex 글"):
            llm.generate_article("주제: 동시 실행")
    finally:
        llm._semaphore.release()  # noqa: SLF001


def test_invalid_reasoning_and_timeout_configuration_are_rejected():
    with pytest.raises(LLMError, match="REASONING"):
        CodexCliProvider(reasoning_effort="extreme", environment={})
    with pytest.raises(LLMError, match="10초 이상"):
        CodexCliProvider(timeout=3, environment={})
