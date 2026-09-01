"""Selector Health Check (docs/05): if any gate fails, automation must not start.
Better a stopped run than a wrong post."""

from __future__ import annotations

from dataclasses import dataclass, field

from publisher.page import PageLike, pick_selector
from publisher.selectors import (
    EDITOR_URL_TEMPLATE,
    HEALTH_CHECKS,
    LOGIN_URL_MARKER,
    SMARTEDITOR_SELECTORS,
)


@dataclass
class HealthReport:
    checks: list[dict] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append({"name": name, "ok": ok, "detail": detail})

    @property
    def all_ok(self) -> bool:
        return bool(self.checks) and all(c["ok"] for c in self.checks)

    @property
    def failed(self) -> list[str]:
        return [c["name"] for c in self.checks if not c["ok"]]


def run_health_check(
    page: PageLike,
    blog_id: str,
    selectors: dict[str, list[str]] | None = None,
) -> HealthReport:
    selectors = selectors or SMARTEDITOR_SELECTORS
    report = HealthReport()

    page.goto(EDITOR_URL_TEMPLATE.format(blog_id=blog_id))

    logged_in = LOGIN_URL_MARKER not in page.url
    report.add("login_session", logged_in, "" if logged_in else "로그인 화면으로 리디렉션됨")
    if not logged_in:
        # everything else is meaningless without a session
        for name, _key in HEALTH_CHECKS:
            report.add(name, False, "skipped: not logged in")
        return report

    help_close = pick_selector(page, selectors["help_close"], require_enabled=True)
    if help_close is not None:
        try:
            page.click(help_close)
        except Exception:  # noqa: BLE001 - popup may close itself
            pass

    for name, key in HEALTH_CHECKS:
        found = pick_selector(
            page,
            selectors[key],
            require_enabled=key == "draft_save_button",
            require_editable=key in {"title", "body"},
        )
        report.add(name, found is not None, found or f"no candidate matched: {key}")

    publish_button = pick_selector(page, selectors["publish_open_button"], require_enabled=True)
    if publish_button is None:
        report.add("tag_input_reachable", False, "publish layer button unavailable")
    else:
        try:
            page.click(publish_button)
            tag_input = pick_selector(page, selectors["tag_input"], require_editable=True)
            report.add(
                "tag_input_reachable",
                tag_input is not None,
                tag_input or "tag input unavailable after opening publish layer",
            )
        except Exception as exc:  # noqa: BLE001 - converted into a failed health gate
            report.add("tag_input_reachable", False, f"publish layer check failed: {type(exc).__name__}")
        finally:
            page.press("Escape")
    return report
