"""Minimal page abstraction so health/editor logic is testable without a browser.

PlaywrightPageAdapter is the real implementation; tests use fakes.
SmartEditor may render directly or inside iframe#mainFrame (docs/05 이중 경로) —
the adapter searches the page first, then every frame.
"""

from __future__ import annotations

from typing import Protocol


class PageLike(Protocol):
    def goto(self, url: str) -> None: ...
    @property
    def url(self) -> str: ...
    def exists(self, selector: str) -> bool: ...
    def click(self, selector: str) -> None: ...
    def type_text(self, selector: str, text: str, delay_ms: int) -> None: ...
    def press(self, key: str) -> None: ...


class PlaywrightPageAdapter:
    """Wraps a sync_api Page. Import of playwright stays inside browser.py."""

    def __init__(self, page):
        self._page = page

    def goto(self, url: str) -> None:
        self._page.goto(url, wait_until="domcontentloaded")

    @property
    def url(self) -> str:
        return self._page.url

    def _find(self, selector: str):
        for frame in [self._page.main_frame, *self._page.frames]:
            try:
                locator = frame.locator(selector).first
                if locator.count() > 0:
                    return locator
            except Exception:  # noqa: BLE001 - detached frames are expected noise
                continue
        return None

    def exists(self, selector: str) -> bool:
        return self._find(selector) is not None

    def click(self, selector: str) -> None:
        locator = self._find(selector)
        if locator is None:
            raise LookupError(f"selector not found: {selector}")
        locator.click()

    def type_text(self, selector: str, text: str, delay_ms: int) -> None:
        locator = self._find(selector)
        if locator is None:
            raise LookupError(f"selector not found: {selector}")
        locator.click()
        locator.press_sequentially(text, delay=delay_ms)

    def press(self, key: str) -> None:
        self._page.keyboard.press(key)


def pick_selector(page: PageLike, candidates: list[str]) -> str | None:
    for selector in candidates:
        if page.exists(selector):
            return selector
    return None
