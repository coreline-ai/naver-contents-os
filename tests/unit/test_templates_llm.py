import json

import httpx
import pytest

from planner.templates import ACTIVE_TYPES, SYSTEM_PROMPT, TEMPLATES, build_prompt, is_active
from planner.types import BlogType
from providers.llm.base import LLMError
from providers.llm.ollama import OllamaProvider


def test_all_eight_blog_types_have_structure():
    assert set(TEMPLATES) == set(BlogType)
    assert all(len(sections) >= 4 for sections in TEMPLATES.values())


def test_all_blog_types_are_active_for_generation():
    assert ACTIVE_TYPES == set(BlogType)
    assert all(is_active(blog_type) for blog_type in BlogType)
    assert "사용자 메모나 승인된 근거에 없는 고유명사, 준비물, 장비" in SYSTEM_PROMPT


def test_build_prompt_contains_sections_and_requirements():
    prompt = build_prompt(
        "애드포스트 승인 조건", "애드포스트 승인", BlogType.POLICY,
        angle="실제 질문에 답하는 글", questions=["승인 얼마나 걸리나요?"],
    )
    assert "2,500자 전후" in prompt
    assert "2,250~2,875자" in prompt
    assert "결론 요약" in prompt and "주의사항" in prompt
    assert "승인 얼마나 걸리나요?" in prompt
    assert prompt.index("1. 결론 요약") < prompt.index("2. 조건") < prompt.index("5. 주의사항")


def test_build_prompt_supports_all_blog_types():
    for blog_type in BlogType:
        prompt = build_prompt("테스트 글", "테스트", blog_type)
        assert blog_type.value in prompt
        assert TEMPLATES[blog_type][0].name in prompt


def make_ollama(handler):
    return OllamaProvider(transport=httpx.MockTransport(handler))


def test_ollama_resolves_first_installed_model_and_generates():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3:8b"}, {"name": "llama3"}]})
        body = json.loads(request.read())
        assert body["model"] == "qwen3:8b"
        assert body["think"] is False
        assert body["options"] == {"num_ctx": 16384, "num_predict": 4096}
        return httpx.Response(200, json={"message": {"content": "제목: 테스트\n\n본문"}})

    provider = make_ollama(handler)
    out = provider.generate("프롬프트", system="시스템")
    assert out.startswith("제목:")


def test_ollama_uses_request_specific_output_budget():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3:4b"}]})
        body = json.loads(request.read())
        assert body["options"]["num_predict"] == 900
        return httpx.Response(200, json={"message": {"content": "제목: 테스트\n\n본문"}})

    assert make_ollama(handler).generate("프롬프트", max_tokens=900)


def test_ollama_structured_article_returns_only_title_and_body():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3:4b"}]})
        body = json.loads(request.read())
        assert body["think"] is False
        assert body["format"]["required"] == ["title", "sections"]
        assert body["format"]["properties"]["sections"]["minItems"] == 10
        assert "180~300자" in body["format"]["properties"]["sections"]["items"]["properties"]["content"]["description"]
        assert body["options"]["num_ctx"] == 16384
        assert body["options"]["num_predict"] == 3250
        return httpx.Response(
            200,
            json={"message": {"content": json.dumps({
                "title": "완성 제목",
                "sections": [{"heading": "핵심 안내", "content": "완성 본문"}],
            })}},
        )

    result = make_ollama(handler).generate_article("프롬프트", max_tokens=3250)
    assert result == "제목: 완성 제목\n\n핵심 안내\n완성 본문"


def test_ollama_structured_article_rejects_truncated_json():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3:4b"}]})
        return httpx.Response(200, json={"message": {"content": '{"title":"미완성'}})

    with pytest.raises(LLMError, match="구조화 글 생성 실패"):
        make_ollama(handler).generate_article("프롬프트", max_tokens=3250)


def test_ollama_no_models_raises():
    provider = make_ollama(lambda r: httpx.Response(200, json={"models": []}))
    with pytest.raises(LLMError):
        provider.generate("x")


def test_ollama_empty_content_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "m"}]})
        return httpx.Response(200, json={"message": {"content": "  "}})

    with pytest.raises(LLMError):
        make_ollama(handler).generate("x")
