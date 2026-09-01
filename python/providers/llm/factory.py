"""LLM provider selection from settings (V2).

`local` (default) keeps everything on-machine via Ollama. `openai_compat` sends
draft prompts to the configured OpenAI-compatible endpoint — an explicit user
choice (docs/11). The settings object is duck-typed so this package never
imports app code.
"""

from __future__ import annotations

from providers.llm.base import LLMError, LLMProvider
from providers.llm.ollama import OllamaProvider
from providers.llm.openai_compat import OpenAICompatProvider

SUPPORTED_PROVIDERS = ("local", "openai_compat")


def build_llm_provider(settings) -> LLMProvider:
    provider = getattr(settings, "llm_provider", "local") or "local"
    if provider == "local":
        return OllamaProvider(settings.ollama_base_url, settings.ollama_model)
    if provider == "openai_compat":
        if getattr(settings, "codex_proxy_autostart", False):
            from providers.llm.proxy_launcher import ensure_codex_proxy

            ensure_codex_proxy(settings)
        return OpenAICompatProvider(
            settings.openai_compat_base_url,
            settings.openai_compat_api_key,
            settings.openai_compat_model,
        )
    raise LLMError(
        f"지원하지 않는 LLM_PROVIDER 값입니다: {provider} (사용 가능: {', '.join(SUPPORTED_PROVIDERS)})"
    )
