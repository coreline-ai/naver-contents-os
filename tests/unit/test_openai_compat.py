import json

import httpx
import pytest

from providers.llm.base import LLMError
from providers.llm.openai_compat import OpenAICompatProvider

MODELS_BODY = {"data": [{"id": "gpt-5.4"}, {"id": "gpt-5.4-mini"}]}
CHAT_BODY = {"choices": [{"message": {"role": "assistant", "content": "제목: 테스트\n\n본문"}}]}


def make_provider(handler, **kwargs) -> OpenAICompatProvider:
    return OpenAICompatProvider(transport=httpx.MockTransport(handler), **kwargs)


def test_generate_with_configured_model_and_no_api_key():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=CHAT_BODY)

    provider = make_provider(handler, model="gpt-5.4")
    out = provider.generate("프롬프트", system="시스템")

    assert out.startswith("제목:")
    request = requests[0]
    assert request.url.path == "/v1/chat/completions"
    assert "authorization" not in request.headers  # no key -> no header
    body = json.loads(request.content)
    assert body["model"] == "gpt-5.4"
    assert body["stream"] is False
    assert [m["role"] for m in body["messages"]] == ["system", "user"]


def test_api_key_becomes_bearer_header():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer sk-test"
        return httpx.Response(200, json=CHAT_BODY)

    make_provider(handler, model="m", api_key="sk-test").generate("x")


def test_model_resolved_from_models_endpoint():
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json=MODELS_BODY)
        return httpx.Response(200, json=CHAT_BODY)

    provider = make_provider(handler)
    provider.generate("x")
    assert provider.model_name == "gpt-5.4"
    assert paths == ["/v1/models", "/v1/chat/completions"]


def test_empty_models_list_raises():
    provider = make_provider(lambda r: httpx.Response(200, json={"data": []}))
    with pytest.raises(LLMError, match="모델이 없습니다"):
        provider.generate("x")


@pytest.mark.parametrize("status", [401, 403])
def test_auth_rejection_mentions_codex_login(status):
    provider = make_provider(lambda r: httpx.Response(status), model="m")
    with pytest.raises(LLMError, match="codex login"):
        provider.generate("x")


def test_connection_failure_mentions_proxy_startup():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    provider = make_provider(handler, model="m")
    with pytest.raises(LLMError, match="프록시"):
        provider.generate("x")


def test_429_is_classified_and_not_retried():
    calls = {"count": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["count"] += 1
        return httpx.Response(429)

    provider = make_provider(handler, model="m")
    with pytest.raises(LLMError, match="429"):
        provider.generate("x")
    assert calls["count"] == 1  # generation is not idempotent: no auto retry


def test_non_json_body_is_schema_error_regardless_of_content_type():
    # adopted lesson DL-...42b6f755: never trust content-type, classify parse failure
    provider = make_provider(
        lambda r: httpx.Response(200, text="<html>oops</html>", headers={"content-type": "application/json"}),
        model="m",
    )
    with pytest.raises(LLMError, match="스키마"):
        provider.generate("x")


def test_unexpected_choice_shape_and_empty_content():
    provider = make_provider(lambda r: httpx.Response(200, json={"choices": []}), model="m")
    with pytest.raises(LLMError, match="스키마"):
        provider.generate("x")

    provider2 = make_provider(
        lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "  "}}]}), model="m"
    )
    with pytest.raises(LLMError, match="빈 응답"):
        provider2.generate("x")


def test_error_messages_never_contain_api_key():
    provider = make_provider(lambda r: httpx.Response(401), model="m", api_key="sk-super-secret")
    with pytest.raises(LLMError) as exc:
        provider.generate("x")
    assert "sk-super-secret" not in str(exc.value)
