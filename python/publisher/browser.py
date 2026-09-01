"""Attach to the user's own running Chrome over CDP — the logged-in session is used
as-is; no Naver credentials are stored or typed by code (docs/05, docs/11).

Start Chrome once with:
    /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\
        --remote-debugging-port=9222
"""

from __future__ import annotations

from contextlib import contextmanager

from publisher.page import PlaywrightPageAdapter


@contextmanager
def attached_page(cdp_url: str = "http://127.0.0.1:9222"):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(cdp_url)
        try:
            context = browser.contexts[0] if browser.contexts else browser.new_context()
            page = context.new_page()
            try:
                yield PlaywrightPageAdapter(page)
            finally:
                page.close()
        finally:
            browser.close()
