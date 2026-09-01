"""OpenAI-compatible chat provider (V2).

One client covers every OpenAI-compatible endpoint we care about: a local Codex
OAuth proxy (thkdog/codex-openai-proxy, ChatMock), Ollama's OpenAI endpoint, or
LM Studio. Non-streaming text generation only.

Error handling contract (dev-plan/implement_20260901_222443.md):
- connection failure -> how to start the proxy
- 401/403           -> how to re-login (`codex login`)
- 429/5xx           -> classified, never auto-retried (generation is not idempotent)
- unparsable body   -> schema error; the body is parsed regardless of content-type
  (adopted lesson DL-20260901T124143Z-42b6f755)
- the api key never appears in messages or logs
"""

from __future__ import annotations

import httpx

from providers.llm.base import LLMError


class OpenAICompatProvider:
    name = "openai_compat"

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8787/v1",
        api_key: str = "",
        model: str = "",
        transport: httpx.BaseTransport | None = None,
        timeout: float = 300.0,
    ):
        self._base_url = base_url.rstrip("/")
        self._model = model
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        self._http = httpx.Client(
            base_url=self._base_url, headers=headers, timeout=timeout, transport=transport
        )

    @property
    def model_name(self) -> str:
        return self._model

    def _connection_error(self, exc: Exception) -> LLMError:
        return LLMError(
            f"OpenAI 호환 엔드포인트({self._base_url})에 연결할 수 없습니다 ({type(exc).__name__}). "
            "프록시를 먼저 기동하세요: `npx -y @thkdog/codex-openai-proxy` "
            "또는 .env에 CODEX_PROXY_AUTOSTART=true"
        )

    def _status_error(self, status: int) -> LLMError:
        if status in (401, 403):
            return LLMError(
                f"엔드포인트가 인증을 거부했습니다 (HTTP {status}). ChatGPT 세션이 만료되었을 수 "
                "있습니다 — `codex login`으로 재로그인한 뒤 다시 시도하세요."
            )
        if status == 429:
            return LLMError("요청이 제한되었습니다 (HTTP 429). 잠시 후 다시 시도하세요 (자동 재시도 없음).")
        return LLMError(f"엔드포인트 오류 (HTTP {status})")

    def _parse_json(self, response: httpx.Response) -> dict:
        # Bodies are parsed regardless of the content-type header (adopted lesson).
        try:
            data = response.json()
        except ValueError as exc:
            raise LLMError("엔드포인트가 JSON이 아닌 본문을 반환했습니다 (스키마 오류)") from exc
        if not isinstance(data, dict):
            raise LLMError("엔드포인트 JSON 루트가 객체가 아닙니다 (스키마 오류)")
        return data

    def resolve_model(self) -> str:
        if self._model:
            return self._model
        try:
            response = self._http.get("/models")
        except httpx.HTTPError as exc:
            raise self._connection_error(exc) from exc
        if response.status_code != 200:
            raise self._status_error(response.status_code)
        rows = self._parse_json(response).get("data", [])
        model_ids = [r.get("id") for r in rows if isinstance(r, dict) and r.get("id")]
        if not model_ids:
            raise LLMError("엔드포인트에 사용 가능한 모델이 없습니다 (/models 빈 목록)")
        self._model = str(model_ids[0])
        return self._model

    def generate(self, prompt: str, *, system: str = "") -> str:
        model = self.resolve_model()
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        try:
            response = self._http.post(
                "/chat/completions",
                json={"model": model, "messages": messages, "stream": False},
            )
        except httpx.HTTPError as exc:
            raise self._connection_error(exc) from exc
        if response.status_code != 200:
            raise self._status_error(response.status_code)

        data = self._parse_json(response)
        try:
            content = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError("chat/completions 응답이 기대한 스키마가 아닙니다") from exc
        if not content.strip():
            raise LLMError("엔드포인트가 빈 응답을 반환했습니다")
        return content
