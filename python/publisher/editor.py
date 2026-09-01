"""SmartEditor ONE input adapter: title/body/tags then DRAFT SAVE ONLY.

Publishing is intentionally not implemented — the human publishes (docs/01).
Typing is human-paced with random delays; draft save has a conservative fallback
chain (click → ESC → re-find → retry) modeled on the original editor.py (docs/05).
"""

from __future__ import annotations

import random
import time
from typing import Callable

from publisher.markdown import clean_markdown
from publisher.page import PageLike, pick_selector
from publisher.selectors import EDITOR_URL_TEMPLATE, SMARTEDITOR_SELECTORS


class EditorError(Exception):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


class SmartEditorAdapter:
    def __init__(
        self,
        page: PageLike,
        selectors: dict[str, list[str]] | None = None,
        rng: Callable[[], float] = random.random,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        self._page = page
        self._selectors = selectors or SMARTEDITOR_SELECTORS
        self._rng = rng
        self._sleep = sleeper

    def _delay_ms(self) -> int:
        return int(30 + self._rng() * 90)  # 30~120ms per char, human-ish

    def _require(self, key: str, stage: str) -> str:
        selector = pick_selector(self._page, self._selectors[key])
        if selector is None:
            raise EditorError(stage, f"no candidate selector matched: {key}")
        return selector

    def open(self, blog_id: str) -> None:
        self._page.goto(EDITOR_URL_TEMPLATE.format(blog_id=blog_id))
        self.dismiss_popups()

    def dismiss_popups(self) -> None:
        selector = pick_selector(self._page, self._selectors["help_close"])
        if selector is not None:
            try:
                self._page.click(selector)
            except Exception:  # noqa: BLE001 - popup may have closed itself
                pass

    def input_title(self, title: str) -> None:
        selector = self._require("title", "input_title")
        self._page.type_text(selector, clean_markdown(title), self._delay_ms())
        self._sleep(0.2 + self._rng() * 0.3)

    def input_body(self, body: str) -> None:
        selector = self._require("body", "input_body")
        text = clean_markdown(body)
        for paragraph in text.split("\n"):
            if paragraph.strip():
                self._page.type_text(selector, paragraph, self._delay_ms())
            self._page.press("Enter")
            self._sleep(0.1 + self._rng() * 0.2)

    def input_tags(self, tags: list[str]) -> None:
        if not tags:
            return
        # tag UI lives on the publish layer; opening it does NOT publish
        self._page.click(self._require("publish_open_button", "input_tags"))
        self._sleep(0.4)
        selector = self._require("tag_input", "input_tags")
        for tag in tags[:10]:
            self._page.type_text(selector, tag.strip().replace(" ", ""), self._delay_ms())
            self._page.press("Enter")
        # leave the publish layer so a stray click cannot publish
        self._page.press("Escape")

    def save_draft(self) -> None:
        try:
            self._page.click(self._require("draft_save_button", "draft_save"))
            return
        except (EditorError, LookupError, RuntimeError):
            pass
        # fallback: clear layers/focus, re-find, retry once (docs/05 fallback 체계)
        self._page.press("Escape")
        self._sleep(0.5)
        selector = pick_selector(self._page, self._selectors["draft_save_button"])
        if selector is None:
            raise EditorError("draft_save", "draft save button unreachable after fallback")
        self._page.click(selector)
