"""LLM provider selection from settings (V2).

`local` keeps everything on-machine via Ollama. `codex_cli` invokes the official
Codex CLI and lets the CLI reuse its own ChatGPT login. `openai_compat` sends
draft prompts to an explicitly configured compatible endpoint. The settings
object is duck-typed so this package never imports app code.
"""

from __future__ import annotations

from providers.llm.base import LLMError, LLMProvider
from providers.llm.codex_cli import CodexCliProvider
from providers.llm.ollama import OllamaProvider
from providers.llm.openai_compat import OpenAICompatProvider

SUPPORTED_PROVIDERS = ("local", "codex_cli", "openai_compat")


def build_llm_provider(settings) -> LLMProvider:
    provider = getattr(settings, "llm_provider", "local") or "local"
    if provider == "local":
        return OllamaProvider(settings.ollama_base_url, settings.ollama_model)
    if provider == "codex_cli":
        return CodexCliProvider(
            executable=getattr(settings, "codex_cli_executable", "codex"),
            model=getattr(settings, "codex_cli_model", "gpt-5.6-sol"),
            reasoning_effort=getattr(settings, "codex_cli_reasoning", "high"),
            timeout=getattr(settings, "codex_cli_timeout_seconds", 300.0),
        )
    if provider == "openai_compat":
        return OpenAICompatProvider(
            settings.openai_compat_base_url,
            settings.openai_compat_api_key,
            settings.openai_compat_model,
        )
    raise LLMError(
        f"지원하지 않는 LLM_PROVIDER 값입니다: {provider} (사용 가능: {', '.join(SUPPORTED_PROVIDERS)})"
    )
