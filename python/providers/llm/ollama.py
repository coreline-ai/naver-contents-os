"""Local LLM provider via Ollama — no API key, nothing leaves the machine (docs/10)."""

from __future__ import annotations

import httpx

from providers.llm.base import LLMError


class OllamaProvider:
    name = "ollama"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:11434",
        model: str = "",
        transport: httpx.BaseTransport | None = None,
        timeout: float = 600.0,
    ):
        self._model = model
        self._http = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    def resolve_model(self) -> str:
        if self._model:
            return self._model
        try:
            response = self._http.get("/api/tags")
            response.raise_for_status()
            models = response.json().get("models", [])
        except (httpx.HTTPError, ValueError) as exc:
            raise LLMError(f"Ollama에 연결할 수 없습니다: {type(exc).__name__}") from exc
        if not models:
            raise LLMError("Ollama에 설치된 모델이 없습니다 (ollama pull <model>)")
        self._model = models[0]["name"]
        return self._model

    @property
    def model_name(self) -> str:
        return self._model

    def generate(self, prompt: str, *, system: str = "") -> str:
        model = self.resolve_model()
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        try:
            response = self._http.post(
                "/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    # Qwen3 같은 추론형 모델은 블로그 초안에서 내부 사고가
                    # 본문보다 길어질 수 있다. 초안은 이미 구조화된 프롬프트를
                    # 사용하므로 사고 모드를 끄고 본문 생성 예산을 명시한다.
                    "think": False,
                    "options": {"num_ctx": 4096, "num_predict": 2048},
                },
            )
            response.raise_for_status()
            content = response.json().get("message", {}).get("content", "")
        except (httpx.HTTPError, ValueError) as exc:
            raise LLMError(f"Ollama 생성 실패: {type(exc).__name__}") from exc
        if not content.strip():
            raise LLMError("Ollama가 빈 응답을 반환했습니다")
        return content
