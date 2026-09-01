"""Codex OAuth proxy launcher (V2, optional).

With CODEX_PROXY_AUTOSTART=true the Local Core starts the proxy itself
(default: `npx -y @thkdog/codex-openai-proxy`, which reuses ~/.codex/auth.json),
waits until the OpenAI-compatible endpoint answers, and cleans the child process
up on exit. The auth file is only checked for existence — never read or logged.
"""

from __future__ import annotations

import atexit
import shlex
import subprocess
import time
from pathlib import Path

import httpx

from providers.llm.base import LLMError


def probe(base_url: str, timeout: float = 2.0) -> bool:
    """True when an OpenAI-compatible endpoint answers /models."""
    try:
        response = httpx.get(f"{base_url.rstrip('/')}/models", timeout=timeout)
    except httpx.HTTPError:
        return False
    return response.status_code == 200


class ProxyHandle:
    def __init__(self, process: subprocess.Popen):
        self.process = process

    def stop(self) -> None:
        if self.process.poll() is not None:
            return
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()


def ensure_codex_proxy(
    settings,
    *,
    popen=subprocess.Popen,
    probe_fn=probe,
    sleeper=time.sleep,
    timeout_seconds: float = 30.0,
    poll_interval: float = 0.5,
) -> ProxyHandle | None:
    """Reuse a running proxy, or start one and wait for readiness.

    Returns None when an endpoint was already answering (nothing to manage),
    else a ProxyHandle whose child process is also terminated at interpreter exit.
    """
    base_url = settings.openai_compat_base_url
    if probe_fn(base_url):
        return None

    auth_file = Path(settings.codex_auth_file)
    if not auth_file.exists():
        raise LLMError(
            f"Codex 인증 파일이 없습니다: {auth_file} — `codex login`으로 ChatGPT 로그인 후 다시 시도하세요."
        )

    process = popen(
        shlex.split(settings.codex_proxy_cmd),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    handle = ProxyHandle(process)
    atexit.register(handle.stop)

    waited = 0.0
    while waited < timeout_seconds:
        if probe_fn(base_url):
            return handle
        if process.poll() is not None:
            raise LLMError(
                f"Codex 프록시 프로세스가 바로 종료되었습니다 (exit {process.returncode}). "
                f"명령을 확인하세요: {settings.codex_proxy_cmd}"
            )
        sleeper(poll_interval)
        waited += poll_interval

    handle.stop()
    raise LLMError(
        f"Codex 프록시가 {timeout_seconds:.0f}초 안에 준비되지 않았습니다 ({base_url}). "
        "수동 기동 후 재시도하거나 CODEX_PROXY_CMD를 확인하세요."
    )
