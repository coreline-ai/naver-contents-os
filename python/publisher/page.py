"""Minimal page abstraction so health/editor logic is testable without a browser.

PlaywrightPageAdapter is the real implementation; tests use fakes.
SmartEditor may render directly or inside iframe#mainFrame (docs/05 이중 경로) —
the adapter searches the page first, then every frame.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4


class PageLike(Protocol):
    def goto(self, url: str) -> None: ...
    @property
    def url(self) -> str: ...
    def exists(self, selector: str) -> bool: ...
    def is_visible(self, selector: str) -> bool: ...
    def is_enabled(self, selector: str) -> bool: ...
    def is_editable(self, selector: str) -> bool: ...
    def wait_for_any(self, selectors: list[str], timeout_ms: int) -> str | None: ...
    def fingerprint(self, selector: str) -> str: ...
    def click(self, selector: str) -> None: ...
    def type_text(self, selector: str, text: str, delay_ms: int) -> None: ...
    def press(self, key: str) -> None: ...
    def capture_evidence(self, label: str) -> dict[str, str]: ...


class PlaywrightPageAdapter:
    """Wraps a sync_api Page. Import of playwright stays inside browser.py."""

    def __init__(self, page, artifact_dir: str | Path | None = None):
        self._page = page
        self._artifact_dir = Path(artifact_dir) if artifact_dir else (
            Path(__file__).resolve().parents[2] / "data" / "publisher-artifacts"
        )

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

    def is_visible(self, selector: str) -> bool:
        locator = self._find(selector)
        return bool(locator is not None and locator.is_visible())

    def is_enabled(self, selector: str) -> bool:
        locator = self._find(selector)
        return bool(locator is not None and locator.is_visible() and locator.is_enabled())

    def is_editable(self, selector: str) -> bool:
        locator = self._find(selector)
        return bool(locator is not None and locator.is_visible() and locator.is_editable())

    def wait_for_any(self, selectors: list[str], timeout_ms: int) -> str | None:
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            found = pick_selector(self, selectors, require_visible=True)
            if found is not None:
                return found
            time.sleep(0.1)
        return None

    def fingerprint(self, selector: str) -> str:
        locator = self._find(selector)
        if locator is None:
            return ""
        return str(
            locator.evaluate(
                """(node) => JSON.stringify({
                    text: (node.textContent || '').trim().slice(0, 120),
                    className: String(node.className || '').slice(0, 200),
                    ariaLive: node.getAttribute('aria-live') || '',
                    dataState: node.getAttribute('data-state') || ''
                })"""
            )
        )

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

    def capture_evidence(self, label: str) -> dict[str, str]:
        """Capture local-only failure evidence without serializing editor text or values."""
        self._artifact_dir.mkdir(parents=True, exist_ok=True)
        safe_label = "".join(char if char.isalnum() or char in "-_" else "-" for char in label)
        stem = f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}-{safe_label[:80]}-{uuid4().hex[:8]}"
        evidence: dict[str, str] = {
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "url": _sanitize_url(self.url),
        }

        screenshot_path = self._artifact_dir / f"{stem}.png"
        try:
            masks = []
            sensitive_selector = (
                "input, textarea, [contenteditable='true'], img, "
                ".se-documentTitle .se-text-paragraph, "
                ".se-title-text, "
                ".se-main-container .se-text-paragraph, "
                ".se-component-content .se-text-paragraph, "
                ".tag_area, [class*='tag'], "
                "[class*='profile'], [class*='account'], [class*='nickname'], [class*='user']"
            )
            for frame in [self._page.main_frame, *self._page.frames]:
                try:
                    masks.append(frame.locator(sensitive_selector))
                except Exception:  # noqa: BLE001 - detached frames are expected noise
                    continue
            self._page.screenshot(
                path=str(screenshot_path),
                full_page=False,
                mask=masks,
                mask_color="#64748b",
            )
            evidence["screenshot_path"] = str(screenshot_path)
        except Exception as exc:  # noqa: BLE001 - partial evidence is still useful
            evidence["screenshot_error"] = type(exc).__name__

        dom_path = self._artifact_dir / f"{stem}.dom.json"
        try:
            structure = self._page.evaluate(
                """() => Array.from(document.querySelectorAll('*')).slice(0, 500).map((node) => ({
                    tag: node.tagName,
                    id: (node.id || '').slice(0, 120),
                    classes: Array.from(node.classList || []).slice(0, 12).map((value) => value.slice(0, 120)),
                    role: (node.getAttribute('role') || '').slice(0, 80),
                    contentEditable: node.getAttribute('contenteditable') || ''
                }))"""
            )
            dom_path.write_text(
                json.dumps(
                    {
                        "captured_at": evidence["captured_at"],
                        "url": evidence["url"],
                        "nodes": structure,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            evidence["dom_path"] = str(dom_path)
        except Exception as exc:  # noqa: BLE001 - screenshot may still be available
            evidence["dom_error"] = type(exc).__name__
        return evidence


def _sanitize_url(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def pick_selector(
    page: PageLike,
    candidates: list[str],
    *,
    require_visible: bool = True,
    require_enabled: bool = False,
    require_editable: bool = False,
) -> str | None:
    for selector in candidates:
        if not page.exists(selector):
            continue
        if require_visible and not page.is_visible(selector):
            continue
        if require_enabled and not page.is_enabled(selector):
            continue
        if require_editable and not page.is_editable(selector):
            continue
        return selector
    return None
