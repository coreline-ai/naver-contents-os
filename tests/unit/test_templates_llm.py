import httpx
import pytest

from planner.templates import ACTIVE_TYPES, TEMPLATES, build_prompt, is_active
from planner.types import BlogType
from providers.llm.base import LLMError
from providers.llm.ollama import OllamaProvider


def test_all_eight_blog_types_have_structure():
    assert set(TEMPLATES) == set(BlogType)
    assert all(len(sections) >= 4 for sections in TEMPLATES.values())


def test_v1_active_types():
    assert ACTIVE_TYPES == {BlogType.HOWTO, BlogType.POLICY, BlogType.REVIEW}
    assert is_active(BlogType.POLICY)
    assert not is_active(BlogType.COMPARISON)


def test_build_prompt_contains_sections_and_requirements():
    prompt = build_prompt(
        "애드포스트 승인 조건", "애드포스트 승인", BlogType.POLICY,
        angle="실제 질문에 답하는 글", questions=["승인 얼마나 걸리나요?"],
    )
    assert "2500자 이상" in prompt
    assert "결론 요약" in prompt and "주의사항" in prompt
    assert "승인 얼마나 걸리나요?" in prompt
    assert prompt.index("1. 결론 요약") < prompt.index("2. 조건") < prompt.index("5. 주의사항")


def test_build_prompt_rejects_structure_only_types():
    with pytest.raises(ValueError):
        build_prompt("비교글", "kw", BlogType.COMPARISON)


def make_ollama(handler):
    return OllamaProvider(transport=httpx.MockTransport(handler))


def test_ollama_resolves_first_installed_model_and_generates():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3:8b"}, {"name": "llama3"}]})
        body = request.read().decode()
        assert '"model": "qwen3:8b"' in body or '"model":"qwen3:8b"' in body
        return httpx.Response(200, json={"message": {"content": "제목: 테스트\n\n본문"}})

    provider = make_ollama(handler)
    out = provider.generate("프롬프트", system="시스템")
    assert out.startswith("제목:")


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
