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

    for name, key in HEALTH_CHECKS:
        found = pick_selector(page, selectors[key])
        report.add(name, found is not None, found or f"no candidate matched: {key}")
    return report
