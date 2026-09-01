import pytest

from publisher.editor import EditorError, SmartEditorAdapter
from publisher.health import HealthReport, run_health_check
from publisher.jobs import PublishJobRunner
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

    def click(self, selector: str) -> None:
        if selector in self.fail_click:
            raise RuntimeError(f"click failed: {selector}")
        self.actions.append(("click", selector))

    def type_text(self, selector: str, text: str, delay_ms: int) -> None:
        self.actions.append(("type", selector, text))

    def press(self, key: str) -> None:
        self.actions.append(("press", key))


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
    report = run_health_check(FakePage(), "tester")
    assert report.all_ok
    assert {c["name"] for c in report.checks} >= {"login_session", "title_area", "draft_save_button"}


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
    assert page.actions == []  # not a single editor interaction happened
    job = store.jobs[result["job_id"]]
    assert job["error_code"] == "health_check_failed"


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
    assert not any(a[0] == "click" and a[1] in SMARTEDITOR_SELECTORS["draft_save_button"] for a in page.actions)


def test_save_draft_fallback_esc_then_retry():
    primary = SMARTEDITOR_SELECTORS["draft_save_button"][0]

    class FlakyPage(FakePage):
        def __init__(self):
            super().__init__()
            self.attempts = 0

        def click(self, selector):
            if selector == primary and self.attempts == 0:
                self.attempts += 1
                raise RuntimeError("obscured by layer")
            super().click(selector)

    page = FlakyPage()
    make_adapter(page).save_draft()
    assert ("press", "Escape") in page.actions
    assert ("click", primary) in page.actions


def test_save_draft_fails_without_success_signal():
    existing = ALL_SELECTORS - set(SMARTEDITOR_SELECTORS["draft_save_success"])
    page = FakePage(existing=existing)
    with pytest.raises(EditorError, match="success signal not observed") as exc:
        make_adapter(page).save_draft()
    assert exc.value.stage == "draft_save"


def test_adapter_raises_editor_error_when_no_candidate_matches():
    page = FakePage(existing=set())
    with pytest.raises(EditorError) as exc:
        make_adapter(page).input_title("제목")
    assert exc.value.stage == "input_title"
