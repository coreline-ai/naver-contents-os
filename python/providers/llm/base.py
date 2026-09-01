from __future__ import annotations

from typing import Protocol


class LLMError(Exception):
    pass


class LLMProvider(Protocol):
    name: str

    def generate(self, prompt: str, *, system: str = "") -> str: ...
