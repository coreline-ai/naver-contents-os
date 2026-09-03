import json
from pathlib import Path

import pytest

from publisher.editor import EditorError, SmartEditorAdapter
from publisher.health import EDITOR_LOAD_TIMEOUT_MS, HealthReport, run_health_check
from publisher.jobs import PublishJobRunner
from publisher.page import PlaywrightPageAdapter
from publisher.selectors import SMARTEDITOR_SELECTORS

ALL_SELECTORS = {sel for candidates in SMARTEDITOR_SELECTORS.values() for sel in candidates}


class FakePage:
    def __init__(self, existing: set[str] | None = None, url="https://blog.naver.com/tester/postwrite",
                 fail_click: set[str] | None = None, hidden: set[str] | None = None,
                 disabled: set[str] | None = None, readonly: set[str] | None = None):
        self.existing = ALL_SELECTORS if existing is None else existing
        self._url = url
        self.fail_click = fail_click or set()
        self.hidden = hidden or set()
        self.disabled = disabled or set()
        self.readonly = readonly or set()
        self.actions: list[tuple] = []
        self.state_revision = 0

    def goto(self, url: str) -> None:
        self.actions.append(("goto", url))

    @property
    def url(self) -> str:
        return self._url

    def exists(self, selector: str) -> bool:
        return selector in self.existing

    def is_visible(self, selector: str) -> bool:
        return selector in self.existing and selector not in self.hidden

    def is_enabled(self, selector: str) -> bool:
        return self.is_visible(selector) and selector not in self.disabled

    def is_editable(self, selector: str) -> bool:
        return self.is_enabled(selector) and selector not in self.readonly

    def wait_for_any(self, selectors: list[str], timeout_ms: int) -> str | None:
        self.actions.append(("wait_for_any", tuple(selectors), timeout_ms))
        return next((s for s in selectors if self.is_visible(s)), None)

    def fingerprint(self, selector: str) -> str:
        if selector in SMARTEDITOR_SELECTORS["draft_save_state"]:
            return f"{selector}:{self.state_revision}"
        return selector

    def click(self, selector: str) -> None:
        if selector in self.fail_click:
            raise RuntimeError(f"click failed: {selector}")
        self.actions.append(("click", selector))
        if selector in SMARTEDITOR_SELECTORS["draft_save_button"]:
            self.state_revision += 1

    def type_text(self, selector: str, text: str, delay_ms: int) -> None:
        self.actions.append(("type", selector, text))

    def press(self, key: str) -> None:
        self.actions.append(("press", key))

    def capture_evidence(self, label: str) -> dict[str, str]:
        self.actions.append(("capture_evidence", label))
        return {
            "screenshot_path": f"/local-only/{label}.png",
            "dom_path": f"/local-only/{label}.dom.json",
        }


class MemoryJobStore:
    def __init__(self):
        self.jobs: dict[int, dict] = {}

    def create(self, draft_id: int) -> int:
        job_id = len(self.jobs) + 1
        self.jobs[job_id] = {"draft_id": draft_id, "history": []}
        return job_id

    def update(self, job_id, *, status, stage, error_code, detail, history_entry):
        job = self.jobs[job_id]
        job.update(status=status, stage=stage, error_code=error_code, detail=detail)
        job["history"].append(history_entry)


def make_adapter(page):
    return SmartEditorAdapter(page, rng=lambda: 0.0, sleeper=lambda _s: None)


def test_health_check_passes_with_full_dom():
    page = FakePage()
    report = run_health_check(page, "tester")
    assert report.all_ok
    assert {c["name"] for c in report.checks} >= {"login_session", "title_area", "draft_save_button"}
    assert (
        "wait_for_any",
        tuple(SMARTEDITOR_SELECTORS["editor_root"]),
        EDITOR_LOAD_TIMEOUT_MS,
    ) in page.actions


def test_health_check_fails_when_logged_out():
    page = FakePage(url="https://nid.naver.com/nidlogin.login?url=...")
    report = run_health_check(page, "tester")
    assert not report.all_ok
    assert report.checks[0] == {"name": "login_session", "ok": False, "detail": "로그인 화면으로 리디렉션됨"}


def test_health_check_fails_on_single_missing_selector():
    existing = ALL_SELECTORS - set(SMARTEDITOR_SELECTORS["draft_save_button"])
    report = run_health_check(FakePage(existing=existing), "tester")
    assert not report.all_ok
    assert report.failed == ["draft_save_button"]


def test_health_check_rejects_hidden_or_disabled_controls():
    report = run_health_check(
        FakePage(
            hidden=set(SMARTEDITOR_SELECTORS["title"]),
            disabled=set(SMARTEDITOR_SELECTORS["draft_save_button"]),
        ),
        "tester",
    )
    assert "title_area" in report.failed
    assert "draft_save_button" in report.failed


def test_health_check_opens_publish_layer_and_requires_real_tag_input():
    existing = ALL_SELECTORS - set(SMARTEDITOR_SELECTORS["tag_input"])
    page = FakePage(existing=existing)
    report = run_health_check(page, "tester")
    assert "tag_input_reachable" in report.failed
    assert any(a[0] == "click" and a[1] in SMARTEDITOR_SELECTORS["publish_open_button"] for a in page.actions)
    assert ("press", "Escape") in page.actions


def test_health_check_skips_publish_layer_when_tags_are_not_requested():
    existing = ALL_SELECTORS - set(SMARTEDITOR_SELECTORS["publish_open_button"]) - set(
        SMARTEDITOR_SELECTORS["tag_input"]
    )
    page = FakePage(existing=existing)
    report = run_health_check(page, "tester", require_tags=False)
    assert report.all_ok
    assert "tag_input_reachable" not in {check["name"] for check in report.checks}


def test_runner_stops_before_any_input_when_health_fails():
    page = FakePage()
    adapter = make_adapter(page)
    store = MemoryJobStore()
    bad = HealthReport()
    bad.add("draft_save_button", False, "missing")
    runner = PublishJobRunner(store, health_runner=lambda p, b: bad)

    result = runner.run(page, adapter, draft_id=1, blog_id="tester",
                        title="제목", body="본문", tags=["태그"])

    assert result["status"] == "failed"
    assert result["stage"] == "health_check"
    assert [action for action in page.actions if action[0] != "capture_evidence"] == []
    job = store.jobs[result["job_id"]]
    assert job["error_code"] == "health_check_failed"
    assert job["history"][-1]["evidence"]["screenshot_path"].endswith("health_check.png")


def test_runner_closes_job_when_health_check_raises():
    page = FakePage()
    store = MemoryJobStore()
    runner = PublishJobRunner(
        store,
        health_runner=lambda _page, _blog_id: (_ for _ in ()).throw(TimeoutError("navigation timed out")),
    )

    result = runner.run(
        page, make_adapter(page), draft_id=1, blog_id="tester", title="제목", body="본문", tags=[]
    )

    assert result["status"] == "failed"
    assert result["stage"] == "health_check"
    job = store.jobs[result["job_id"]]
    assert job["error_code"] == "health_check_error"
    assert job["history"][-1]["status"] == "failed"
    assert "evidence" in job["history"][-1]


def test_runner_full_success_records_all_stages_and_never_publishes():
    page = FakePage()
    adapter = make_adapter(page)
    store = MemoryJobStore()
    good = HealthReport()
    good.add("all", True)
    runner = PublishJobRunner(store, health_runner=lambda p, b: good)

    result = runner.run(page, adapter, draft_id=7, blog_id="tester",
                        title="## 제목", body="**본문** 문단", tags=["애드포스트", "두 단어 태그"])

    assert result["status"] == "draft_saved"
    typed = [a for a in page.actions if a[0] == "type"]
    assert any(a[2] == "제목" for a in typed)  # markdown cleaned before typing
    assert any(a[2] == "본문 문단" for a in typed)
    assert ("type", SMARTEDITOR_SELECTORS["tag_input"][0], "두단어태그") in page.actions  # tag spaces removed
    stages = [h["stage"] for h in store.jobs[result["job_id"]]["history"]]
    assert stages[0] == "health_check" and "draft_save" in stages
    # draft save clicked; publish confirm never clicked (layer opened for tags, then ESC)
    clicks = [a[1] for a in page.actions if a[0] == "click"]
    assert SMARTEDITOR_SELECTORS["draft_save_button"][0] in clicks
    assert ("press", "Escape") in page.actions
    assert not any(action[0] == "capture_evidence" for action in page.actions)


def test_real_health_and_runner_navigate_editor_only_once():
    page = FakePage()
    result = PublishJobRunner(MemoryJobStore()).run(
        page,
        make_adapter(page),
        draft_id=1,
        blog_id="tester",
        title="제목",
        body="본문",
        tags=[],
    )
    assert result["status"] == "draft_saved"
    assert len([a for a in page.actions if a[0] == "goto"]) == 1


def test_runner_records_failure_stage_and_stops():
    page = FakePage(fail_click=set(SMARTEDITOR_SELECTORS["publish_open_button"]))
    adapter = make_adapter(page)
    store = MemoryJobStore()
    good = HealthReport()
    good.add("all", True)
    runner = PublishJobRunner(store, health_runner=lambda p, b: good)

    result = runner.run(page, adapter, draft_id=1, blog_id="tester",
                        title="제목", body="본문", tags=["태그"])

    assert result["status"] == "failed"
    assert result["stage"] == "input_tags"
    job = store.jobs[result["job_id"]]
    assert job["stage"] == "input_tags"
    assert "evidence" in job["history"][-1]
    assert not any(a[0] == "click" and a[1] in SMARTEDITOR_SELECTORS["draft_save_button"] for a in page.actions)


def test_runner_normalizes_unexpected_browser_error():
    class BrokenPage(FakePage):
        def type_text(self, selector, text, delay_ms):
            raise ValueError("browser context closed")

    page = BrokenPage()
    store = MemoryJobStore()
    good = HealthReport()
    good.add("all", True)
    runner = PublishJobRunner(store, health_runner=lambda _page, _blog_id: good)

    result = runner.run(
        page, make_adapter(page), draft_id=1, blog_id="tester", title="제목", body="본문", tags=[]
    )

    assert result["status"] == "failed"
    assert result["stage"] == "input_title"
    job = store.jobs[result["job_id"]]
    assert job["error_code"] == "editor_error"
    assert job["history"][-1]["status"] == "failed"


def test_save_draft_fallback_esc_then_retry():
    primary = SMARTEDITOR_SELECTORS["draft_save_button"][0]

    class FlakyPage(FakePage):
        def __init__(self):
            super().__init__()
            self.attempts = 0

        def click(self, selector):
            if selector == primary and self.attempts == 0:
                self.attempts += 1
                raise ValueError("obscured by layer")
            super().click(selector)

    page = FlakyPage()
    make_adapter(page).save_draft()
    assert ("press", "Escape") in page.actions
    assert ("click", primary) in page.actions


def test_live_save_signal_selectors_cover_autosave_message_and_saved_draft_count():
    assert "span[class^='autosave_message__'][class*='is_show__']" in (
        SMARTEDITOR_SELECTORS["draft_save_success"]
    )
    assert "button[class^='save_count_btn__']" in SMARTEDITOR_SELECTORS["draft_save_state"]


def test_save_draft_compares_persistent_state_from_before_typing_autosave():
    class AutosavedBeforeFinalClickPage(FakePage):
        def click(self, selector):
            self.actions.append(("click", selector))

    page = AutosavedBeforeFinalClickPage()
    adapter = make_adapter(page)
    adapter.remember_save_state()
    page.state_revision = 1  # NAVER autosaved while the body was being typed.
    adapter.save_draft()
    assert ("click", SMARTEDITOR_SELECTORS["draft_save_button"][0]) in page.actions


def test_save_draft_fails_without_success_signal():
    existing = ALL_SELECTORS - set(SMARTEDITOR_SELECTORS["draft_save_success"])
    page = FakePage(existing=existing)
    with pytest.raises(EditorError, match="independent draft save signals not observed: confirmation") as exc:
        make_adapter(page).save_draft()
    assert exc.value.stage == "draft_save"


def test_save_draft_fails_without_independent_persistent_state():
    existing = ALL_SELECTORS - set(SMARTEDITOR_SELECTORS["draft_save_state"])
    page = FakePage(existing=existing)
    with pytest.raises(
        EditorError, match="independent draft save signals not observed: persistent_state_change"
    ) as exc:
        make_adapter(page).save_draft()
    assert exc.value.stage == "draft_save"


def test_save_draft_rejects_a_stale_preexisting_save_state():
    class StaleStatePage(FakePage):
        def click(self, selector):
            if selector in self.fail_click:
                raise RuntimeError(f"click failed: {selector}")
            self.actions.append(("click", selector))

    with pytest.raises(EditorError, match="persistent_state_change"):
        make_adapter(StaleStatePage()).save_draft()


def test_save_draft_fails_when_both_signals_are_missing():
    missing = set(SMARTEDITOR_SELECTORS["draft_save_success"]) | set(
        SMARTEDITOR_SELECTORS["draft_save_state"]
    )
    with pytest.raises(EditorError, match="confirmation, persistent_state_change"):
        make_adapter(FakePage(existing=ALL_SELECTORS - missing)).save_draft()


def test_evidence_capture_failure_does_not_replace_job_failure():
    class EvidenceFailurePage(FakePage):
        def capture_evidence(self, label):
            raise OSError("artifact directory unavailable")

    page = EvidenceFailurePage()
    store = MemoryJobStore()
    bad = HealthReport()
    bad.add("editor_entry", False, "missing")
    result = PublishJobRunner(store, health_runner=lambda _page, _blog_id: bad).run(
        page,
        make_adapter(page),
        draft_id=1,
        blog_id="tester",
        title="제목",
        body="본문",
        tags=[],
    )

    assert result["status"] == "failed"
    assert store.jobs[result["job_id"]]["error_code"] == "health_check_failed"
    assert store.jobs[result["job_id"]]["history"][-1]["evidence"] == {
        "capture_error": "OSError"
    }


def test_playwright_evidence_excludes_query_and_editor_text(tmp_path):
    class RawPage:
        url = "https://blog.naver.com/tester/postwrite?token=secret#draft"
        main_frame = None
        frames = []

        def __init__(self):
            self.main_frame = self

        def locator(self, selector):
            assert "contenteditable" in selector
            return f"masked:{selector}"

        def screenshot(self, *, path, full_page, mask, mask_color):
            assert full_page is False
            assert mask and mask_color == "#64748b"
            Path(path).write_bytes(b"png")

        def evaluate(self, _script):
            return [
                {
                    "tag": "DIV",
                    "id": "SE-canvas",
                    "classes": ["se-container"],
                    "role": "textbox",
                    "contentEditable": "true",
                }
            ]

    evidence = PlaywrightPageAdapter(RawPage(), artifact_dir=tmp_path).capture_evidence(
        "job-1-input_body"
    )

    assert evidence["url"] == "https://blog.naver.com/tester/postwrite"
    assert Path(evidence["screenshot_path"]).read_bytes() == b"png"
    dom = json.loads(Path(evidence["dom_path"]).read_text(encoding="utf-8"))
    assert dom["url"] == evidence["url"]
    assert "secret" not in json.dumps(dom, ensure_ascii=False)
    assert "text" not in dom["nodes"][0]


def test_adapter_raises_editor_error_when_no_candidate_matches():
    page = FakePage(existing=set())
    with pytest.raises(EditorError) as exc:
        make_adapter(page).input_title("제목")
    assert exc.value.stage == "input_title"
