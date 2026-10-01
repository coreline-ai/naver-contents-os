"""SQLite/session concurrency regressions, isolated from accounts and providers."""
from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Barrier

import pytest

from app.db import make_engine, make_session_factory
from app.errors import DraftVersionConflict
from app.models_db import Base, Draft, DraftAsset, DraftVersion, Keyword, PublishJob
from app.services.draft_assets import DraftAssetService
from app.services.drafts import SqlJobStore
from app.services.publishing import EXTENSION_STAGES, PublishService


@pytest.fixture
def publisher(tmp_path):
    engine = make_engine(tmp_path / "integrity.sqlite")
    Base.metadata.create_all(engine)
    sessions = make_session_factory(engine)
    with sessions() as session:
        keyword = Keyword(text="격리 자료")
        session.add(keyword)
        session.flush()
        draft = Draft(keyword_id=keyword.id, blog_type="HOWTO", title="격리 원고")
        session.add(draft)
        session.flush()
        session.add(DraftVersion(draft_id=draft.id, version=1, title=draft.title, body="격리 설명 본문. " * 400))
        session.commit()
        draft_id = draft.id
    assets = DraftAssetService(sessions, root=tmp_path / "assets")
    for position in range(4):
        assets.add(draft_id, draft_version=1, filename=f"image-{position}.png", mime_type="image/png",
                   data_base64=base64.b64encode(b"\x89PNG\r\n\x1a\n" + bytes([position]) * 20).decode(),
                   position=position, anchor_after=position + 1, rights_status="approved")
    service = PublishService(sessions, asset_service=assets)
    yield service, sessions, assets, draft_id
    engine.dispose()


def prepare(service, draft_id, *, tags=None):
    return service.prepare(draft_id, blog_id="fixture-blog", tags=tags or ["격리 태그"], cdp_url="",
                           expected_version=1, transport="current_chrome_extension")


def receipts(command):
    return [{"asset_id": asset["asset_id"], "sha256": asset["sha256"],
             "remote_url": f"https://postfiles.pstatic.net/fixture/{asset['sha256']}.png?type=w966"}
            for asset in command["assets"]]


def event(service, command, stage, status, **kw):
    return service.record_extension_event(command["job_id"], attempt_id=command["attempt_id"],
                                          lease_owner=command["lease_owner"], stage=stage, status=status, **kw)


def saved_checkpoint(service, command, *, save_passed=True):
    for stage in EXTENSION_STAGES[:-1]:
        if stage == "draft_save" and not save_passed:
            event(service, command, stage, "running")
            return
        values = {"image_receipts": receipts(command)} if stage == "upload_images" else None
        assert event(service, command, stage, "passed", verification=values)["status"] == "running"


def verified(command):
    return {"actual_title_hash": command["title_hash"], "actual_body_hash": command["body_hash"],
            "body_chars": command["body_chars"], "image_count": len(command["assets"]),
            "remote_image_count": len(command["assets"]), "actual_tags": ["격리태그"],
            "asset_manifest_hash": command["asset_manifest_hash"], "image_receipts": receipts(command)}


def test_two_sessions_claim_exactly_one_worker(publisher):
    service, sessions, _, draft_id = publisher
    task = prepare(service, draft_id)
    barrier = Barrier(2)
    def claim(owner):
        store = SqlJobStore(sessions)
        # Both observe the same old, unleased row before the race.
        assert store.get(task.job_id)["lease_owner"] is None
        barrier.wait(timeout=5)
        return store.claim_lease(task.job_id, owner)
    with ThreadPoolExecutor(max_workers=2) as pool:
        result = list(pool.map(claim, ("worker-a", "worker-b")))
    assert sorted(result) == [False, True]
    assert not SqlJobStore(sessions).claim_lease(task.job_id, service.get_job(task.job_id)["lease_owner"])


def test_two_sessions_idempotent_create_returns_same_job(publisher, monkeypatch):
    service, sessions, _, draft_id = publisher
    barrier = Barrier(2)
    original = service._store.by_idempotency_key
    def read_before_race(key):
        value = original(key)
        barrier.wait(timeout=5)
        return value
    monkeypatch.setattr(service._store, "by_idempotency_key", read_before_race)
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = list(pool.map(lambda _: prepare(service, draft_id), range(2)))
    assert jobs[0].job_id == jobs[1].job_id
    with sessions() as session:
        assert session.query(PublishJob).count() == 1


def test_two_sessions_preserve_all_history_updates(publisher):
    _, sessions, _, draft_id = publisher
    store = SqlJobStore(sessions)
    job_id = store.create(draft_id)  # legacy runner also uses this serialized path
    barrier = Barrier(2)
    def update(label):
        local = SqlJobStore(sessions)
        assert local.get(job_id)["history"] == []
        barrier.wait(timeout=5)
        local.update(job_id, status="running", stage="input_body", error_code=None, detail=label,
                     history_entry={"stage": "input_body", "status": "running", "detail": label})
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(update, ("event-a", "event-b")))
    assert {entry["detail"] for entry in store.get(job_id)["history"]} == {"event-a", "event-b"}


def test_two_sessions_extension_progress_preserves_history_and_terminal_failure(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    command = service.command(task.job_id, lease_owner="worker")
    barrier = Barrier(2)
    def running(label):
        barrier.wait(timeout=5)
        return event(service, command, "browser_attach", "running", detail=label)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(running, ("progress-a", "progress-b")))
    job = service.get_job(task.job_id)
    assert {item.get("detail") for item in job["history"]} >= {"progress-a", "progress-b"}
    event(service, command, "browser_attach", "failed", error_code="fixture_failure")
    with pytest.raises(ValueError, match="terminal"):
        event(service, command, "browser_attach", "running", detail="late-waiting")
    assert service.get_job(task.job_id)["error_code"] == "fixture_failure"


def test_late_waiting_request_cannot_replace_running_or_failed_state(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    command = service.command(task.job_id, lease_owner="worker")
    service.mark_waiting_extension(task)
    assert service.get_job(task.job_id)["status"] == "running"
    event(service, command, "browser_attach", "failed", error_code="fixture_failure")
    service.mark_waiting_extension(task)
    assert service.get_job(task.job_id)["error_code"] == "fixture_failure"


def test_active_job_prevents_asset_add_delete_and_different_job(publisher):
    service, _, assets, draft_id = publisher
    prepare(service, draft_id)
    with pytest.raises(ValueError, match="locked"):
        assets.delete(draft_id, assets.list(draft_id, 1)[0]["asset_id"])
    with pytest.raises(ValueError, match="locked"):
        assets.add(draft_id, draft_version=1, filename="new.png", mime_type="image/png",
                   data_base64=base64.b64encode(b"\x89PNG\r\n\x1a\nnew").decode(),
                   position=5, anchor_after=2, rights_status="approved")
    with pytest.raises(DraftVersionConflict):
        prepare(service, draft_id, tags=["different-job"])


def test_non_max_image_deletion_changes_manifest_and_is_rejected(publisher):
    service, sessions, assets, draft_id = publisher
    task = prepare(service, draft_id)
    old_manifest = assets.manifest_version(draft_id, 1)
    # Simulate out-of-band DB tampering, bypassing the legitimate API lock.
    with sessions() as session:
        session.delete(session.get(DraftAsset, assets.list(draft_id, 1)[1]["asset_id"]))
        session.commit()
    assert assets.manifest_version(draft_id, 1) != old_manifest
    with pytest.raises(DraftVersionConflict):
        service.command(task.job_id, lease_owner="worker")


def test_tampered_file_is_rejected_before_claim_and_download(publisher):
    service, _, assets, draft_id = publisher
    task = prepare(service, draft_id)
    row = assets.get_row(assets.list(draft_id, 1)[0]["asset_id"])
    Path(row.local_path).write_bytes(b"tampered")
    with pytest.raises(ValueError, match="integrity"):
        service.command(task.job_id, lease_owner="worker")
    assert service.get_job(task.job_id)["status"] == "pending"
    with pytest.raises(ValueError, match="integrity"):
        service.asset_for_job(task.job_id, row.id)


def test_skip_stages_owner_and_old_attempt_cannot_complete_job(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    first = service.command(task.job_id, lease_owner="worker-a")
    with pytest.raises(ValueError, match="transition"):
        event(service, first, "reopen_verify", "passed", verification=verified(first))
    wrong_owner = {**first, "lease_owner": "worker-b"}
    with pytest.raises(ValueError, match="stale"):
        event(service, wrong_owner, "browser_attach", "passed")
    saved_checkpoint(service, first)
    event(service, first, "reopen_verify", "failed")
    service.retry(task.job_id)
    second = service.command(task.job_id, lease_owner="worker-b")
    assert second["resume_stage"] == "reopen_verify"
    assert second["image_receipts"] == receipts(first)
    with pytest.raises(ValueError, match="stale"):
        event(service, first, "reopen_verify", "passed", verification=verified(first))
    assert event(service, second, "reopen_verify", "passed", verification=verified(second))["status"] == "verified_draft_saved"
    assert not service._store.claim_lease(task.job_id, "terminal-worker")


def test_draft_save_ack_uncertain_resumes_only_reopen(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    first = service.command(task.job_id, lease_owner="worker-a")
    saved_checkpoint(service, first, save_passed=False)
    event(service, first, "draft_save", "failed", error_code="draft_save_ack_timeout")
    service.retry(task.job_id)
    service.mark_waiting_extension(task)
    second = service.next_extension_command("worker-b", blog_ids=["fixture-blog"])
    assert second["resume_stage"] == "reopen_verify"
    with pytest.raises(ValueError, match="transition"):
        event(service, second, "prepare_editor", "passed")
    assert event(service, second, "reopen_verify", "passed", verification=verified(second))["status"] == "verified_draft_saved"


def test_lost_passed_response_at_save_also_preserves_checkpoint(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    first = service.command(task.job_id, lease_owner="worker-a")
    saved_checkpoint(service, first)
    # The server persisted 'passed', but the client missed that HTTP response.
    failed = event(service, first, "draft_save", "failed", error_code="response_lost")
    assert failed["status"] == "failed"
    service.retry(task.job_id)
    second = service.command(task.job_id, lease_owner="worker-b")
    assert second["resume_stage"] == "reopen_verify"
    assert event(service, second, "reopen_verify", "passed", verification=verified(second))["status"] == "verified_draft_saved"


def test_expired_lease_fails_without_automatic_writer_and_unlocks_assets(publisher):
    service, sessions, assets, draft_id = publisher
    task = prepare(service, draft_id)
    command = service.command(task.job_id, lease_owner="worker-a")
    saved_checkpoint(service, command, save_passed=False)
    with sessions() as session:
        row = session.get(PublishJob, task.job_id)
        row.lease_expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.commit()
    assert service.next_extension_command("worker-b", blog_ids=["fixture-blog"]) is None
    failed = service.get_job(task.job_id)
    assert failed["status"] == "failed" and failed["error_code"] == "lease_expired"
    assert failed["history"][-1]["error_code"] == "lease_expired"
    with pytest.raises(ValueError, match="stale"):
        event(service, command, "draft_save", "passed")
    service.retry(task.job_id)
    next_command = service.command(task.job_id, lease_owner="worker-b")
    assert next_command["resume_stage"] == "reopen_verify"
    assert event(service, next_command, "reopen_verify", "passed", verification=verified(next_command))["status"] == "verified_draft_saved"
    assert assets.delete(draft_id, assets.list(draft_id, 1)[0]["asset_id"])


def test_success_requires_correct_receipts_not_only_counts(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    command = service.command(task.job_id, lease_owner="worker")
    saved_checkpoint(service, command)
    values = verified(command)
    values["image_receipts"][0]["remote_url"] = "https://postfiles.pstatic.net/wrong.png"
    result = event(service, command, "reopen_verify", "passed", verification=values)
    assert result["status"] == "failed"
    assert result["verification"]["image_receipts"] == receipts(command)


def test_normalized_remote_urls_and_tags_can_verify(publisher):
    service, _, _, draft_id = publisher
    task = prepare(service, draft_id)
    command = service.command(task.job_id, lease_owner="worker")
    saved_checkpoint(service, command)
    values = verified(command)
    for receipt in values["image_receipts"]:
        receipt["remote_url"] = receipt["remote_url"].replace("postfiles", "blogfiles").replace("?type=w966", "?type=w800")
    assert event(service, command, "reopen_verify", "passed", verification=values)["status"] == "verified_draft_saved"


def test_legacy_jobs_without_snapshot_fail_closed(publisher):
    service, sessions, _, draft_id = publisher
    with sessions() as session:
        row = PublishJob(draft_id=draft_id, status="failed", stage="reopen_verify", transport="current_chrome_extension",
                         request_payload={"blog_id": "fixture-blog", "tags": []}, verification={}, history=[])
        session.add(row)
        session.commit()
        job_id = row.id
    with pytest.raises(DraftVersionConflict, match="새 버전으로 저장"):
        service.retry(job_id)
    assert service.get_job(job_id)["status"] == "failed"
