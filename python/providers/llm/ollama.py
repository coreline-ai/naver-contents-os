"""Local LLM provider via Ollama — no API key, nothing leaves the machine (docs/10)."""

from __future__ import annotations

import json

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

    def generate(
        self,
        prompt: str,
        *,
        system: str = "",
        max_tokens: int | None = None,
    ) -> str:
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
                    "options": {
                        "num_ctx": 16384,
                        "num_predict": max_tokens or 4096,
                    },
                },
            )
            response.raise_for_status()
            content = response.json().get("message", {}).get("content", "")
        except (httpx.HTTPError, ValueError) as exc:
            raise LLMError(f"Ollama 생성 실패: {type(exc).__name__}") from exc
        if not content.strip():
            raise LLMError("Ollama가 빈 응답을 반환했습니다")
        return content

    def generate_article(
        self,
        prompt: str,
        *,
        system: str = "",
        max_tokens: int | None = None,
    ) -> str:
        """Use sectioned structured output so reasoning cannot replace the article."""

        model = self.resolve_model()
        is_expansion = "이어 붙일 추가 본문" in prompt
        min_sections, max_sections = ((4, 6) if is_expansion else (10, 11))
        content_min, content_max = ((90, 260) if is_expansion else (180, 300))
        schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "sections": {
                    "type": "array",
                    "minItems": min_sections,
                    "maxItems": max_sections,
                    "items": {
                        "type": "object",
                        "properties": {
                            "heading": {
                                "type": "string",
                                "description": "중복되지 않는 한국어 소제목",
                            },
                            "content": {
                                "type": "string",
                                "description": (
                                    f"소제목을 구체화한 {content_min}~{content_max}자의 "
                                    "2~4문장 한국어 완성 문단"
                                ),
                            },
                        },
                        "required": ["heading", "content"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["title", "sections"],
            "additionalProperties": False,
        }
        try:
            response = self._http.post(
                "/api/chat",
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                f"{system}\nJSON 객체의 title과 sections 외에는 출력하지 마세요. "
                                "각 section은 서로 다른 정보를 담고 같은 문장을 반복하지 마세요."
                            ),
                        },
                        {
                            "role": "user",
                            "content": f"{prompt}\n반드시 지정된 JSON 스키마로만 응답하세요.",
                        },
                    ],
                    "stream": False,
                    "think": False,
                    "format": schema,
                    "options": {
                        "num_ctx": 16384,
                        "num_predict": max_tokens or 4096,
                        "temperature": 0.7,
                        "top_p": 0.9,
                        "repeat_penalty": 1.15,
                    },
                },
            )
            response.raise_for_status()
            content = response.json().get("message", {}).get("content", "")
            payload = json.loads(content)
            title = payload.get("title", "")
            sections = payload.get("sections", [])
        except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
            raise LLMError(f"Ollama 구조화 글 생성 실패: {type(exc).__name__}") from exc
        if not isinstance(title, str) or not title.strip() or not isinstance(sections, list):
            raise LLMError("Ollama 구조화 응답에 제목 또는 섹션이 없습니다")
        body_parts = []
        for section in sections:
            if not isinstance(section, dict):
                continue
            heading = section.get("heading", "")
            section_content = section.get("content", "")
            if isinstance(heading, str) and isinstance(section_content, str) and section_content.strip():
                body_parts.append(f"{heading.strip()}\n{section_content.strip()}".strip())
        body = "\n\n".join(body_parts)
        if not body:
            raise LLMError("Ollama 구조화 응답에 완성된 본문 섹션이 없습니다")
        return f"제목: {title.strip()}\n\n{body.strip()}"
