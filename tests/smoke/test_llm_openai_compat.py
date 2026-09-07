"""Live official Codex CLI smoke test.

Runs only when LLM_PROVIDER=codex_cli and the official CLI reports a valid login.
It never reads or inspects a credential file.

Run explicitly: uv run pytest -m smoke tests/smoke/test_llm_openai_compat.py
"""

import pytest

from app.config import get_settings
from providers.llm.factory import build_llm_provider
from providers.llm.base import LLMError

pytestmark = pytest.mark.smoke


def test_codex_cli_generate_live():
    settings = get_settings()
    if settings.llm_provider != "codex_cli":
        pytest.skip("LLM_PROVIDER=codex_cli가 아님")
    provider = build_llm_provider(settings)
    try:
        provider.resolve_model()
    except LLMError as exc:
        pytest.skip(str(exc))
    out = provider.generate("한 단어로만 답하세요: 안녕")
    assert out.strip()
    assert provider.model_name
