"""Live Codex OAuth proxy smoke test.

Runs only when ~/.codex/auth.json exists AND an OpenAI-compatible endpoint is
already answering at OPENAI_COMPAT_BASE_URL (start one first, e.g.
`npx -y @thkdog/codex-openai-proxy`). Uses one tiny real completion.

Run explicitly: uv run pytest -m smoke tests/smoke/test_llm_openai_compat.py
"""

from pathlib import Path

import pytest

from app.config import get_settings
from providers.llm.openai_compat import OpenAICompatProvider
from providers.llm.proxy_launcher import probe

pytestmark = pytest.mark.smoke


def test_codex_proxy_generate_live():
    settings = get_settings()
    if not Path(settings.codex_auth_file).exists():
        pytest.skip("~/.codex/auth.json 없음 (codex login 필요)")
    if not probe(settings.openai_compat_base_url):
        pytest.skip(f"OpenAI 호환 엔드포인트 미기동: {settings.openai_compat_base_url}")

    provider = OpenAICompatProvider(
        settings.openai_compat_base_url,
        settings.openai_compat_api_key,
        settings.openai_compat_model,
    )
    out = provider.generate("한 단어로만 답하세요: 안녕")
    assert out.strip()
    assert provider.model_name
