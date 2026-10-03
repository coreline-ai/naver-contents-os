"""Account-free HTTP contract tests; these do NOT prove a live NAVER save.

The fixture owns its DB/assets, stubs readiness, and never opens a browser or
calls a provider. The real extension/debugger has separate execution tests.
"""
from __future__ import annotations

import base64
import socket

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import api, deps
from app.auth import require_token
from app.config import Settings
from app.db import make_engine, make_session_factory
from app.models_db import Base, Draft, DraftVersion, Keyword, PublishJob
from app.services.draft_assets import DraftAssetService
from app.services.publishing import PublishService


@pytest.fixture
def isolated_publish(tmp_path, monkeypatch):
    def no_network(*_args, **_kwargs):
        raise AssertionError("isolated publisher contract must not use the network")

    monkeypatch.setattr(socket, "create_connection", no_network)
    settings = Settings(_env_file=None, db_path=tmp_path / "contract.sqlite")
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    engine = make_engine(settings.db_path)
    Base.metadata.create_all(engine)
    sessions = make_session_factory(engine)
    body = ("격리 검증 자료입니다. 실제 공개 글이나 계정 인수 결과가 아닙니다.\n\n" * 120).strip()
    with sessions() as session:
        keyword = Keyword(text="격리 검증")
        session.add(keyword)
        session.flush()
        draft = Draft(keyword_id=keyword.id, blog_type="HOWTO", title="계정 없는 계약 검증")
        session.add(draft)
        session.flush()
        session.add(DraftVersion(draft_id=draft.id, version=1, title=draft.title, body=body))
        session.commit()
        draft_id = draft.id
    assets = DraftAssetService(sessions, root=tmp_path / "images")
    for position in range(3):
        # Different synthetic PNG envelopes suffice for the asset API contract;
        # image rendering itself is not exercised in this fixture.
        data = b"\x89PNG\r\n\x1a\n" + f"contract-fixture-{position}".encode()
        assets.add(draft_id, draft_version=1, filename=f"fixture-{position}.png",
                   mime_type="image/png", data_base64=base64.b64encode(data).decode(),
                   position=position, anchor_after=position + 1, rights_status="approved")
    service = PublishService(sessions, asset_service=assets)
    service.heartbeat(extension_id="fixture-worker", version="test", protocol_version=3, build_id="test-build")
    app = FastAPI()
    app.include_router(api.router)
    # Authentication has its own web/extension tests. This fixture isolates
    # publisher HTTP/state contracts and never resolves a real credential.
    app.dependency_overrides[require_token] = lambda: None
    app.dependency_overrides[api.get_publish_service] = lambda: service
    app.dependency_overrides[api.get_draft_asset_service] = lambda: assets
    with TestClient(app) as client:
        yield client, draft_id, sessions, assets
    engine.dispose()


def start(client, draft_id):
    response = client.post(f"/v1/drafts/{draft_id}/publish-jobs", json={
        "blog_id": "contract_blog", "tags": ["자동검증", "임시글"],
        "expected_version": 1, "transport": "current_chrome_extension", "target_worker_id": "fixture-worker",
    })
    assert response.status_code == 202, response.text
    return response.json()


def test_private_asset_preview_checks_owner_integrity_and_auth(isolated_publish, monkeypatch):
    client, draft_id, _sessions, assets = isolated_publish
    row = assets.list(draft_id, 1)[0]
    url = f"/v1/drafts/{draft_id}/assets/{row['asset_id']}/content"
    response = client.get(url)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["content-type"] == "image/png"
    assert client.get(f"/v1/drafts/{draft_id + 1}/assets/{row['asset_id']}/content").status_code == 404
    from pathlib import Path
    Path(assets.get_row(row["asset_id"]).local_path).write_bytes(b"tampered")
    assert client.get(url).status_code == 409
    from types import SimpleNamespace
    monkeypatch.setattr("app.auth.get_settings", lambda: SimpleNamespace(resolve_token=lambda: "fixture-only"))
    del client.app.dependency_overrides[require_token]
    assert client.get(url).status_code == 401


@pytest.mark.parametrize("stored, expected", [
    (None, "none"), ("pending", "pending"), ("waiting_extension", "waiting_extension"),
    ("running", "running"), ("draft_saved", "draft_saved"),
    ("verified_draft_saved", "verified_draft_saved"), ("failed", "failed"),
    ("future_unknown_state", "unknown"),
])
def test_draft_list_http_preserves_delivery_state(isolated_publish, stored, expected):
    """Read-model + HTTP schema regression, using only the fixture-owned DB."""
    from app.services.drafts import DraftService
    client, draft_id, sessions, _assets = isolated_publish
    client.app.dependency_overrides[api.get_draft_service_factory] = lambda: lambda _use_llm=False: DraftService(sessions, None)
    if stored is not None:
        job = start(client, draft_id)
        with sessions() as session:
            row = session.get(PublishJob, job["job_id"])
            row.status = stored
            row.stage = "reopen_verify" if stored == "verified_draft_saved" else "browser_attach"
            session.commit()
    response = client.get("/v1/drafts")
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["draft_id"] == draft_id
    assert item["latest_job_status"] == expected
    if stored is not None:
        with sessions() as session:
            assert session.get(PublishJob, job["job_id"]).status == stored


def claim(client, owner="fixture-worker"):
    response = client.get("/v1/publisher/next-command", params={
        "lease_owner": owner, "blog_id": "contract_blog",
    })
    assert response.status_code == 200, response.text
    return response.json()


def event(client, command, stage, status, **extra):
    return client.post(f"/v1/publish-jobs/{command['job_id']}/events", json={
        "stage": stage, "status": status,
        "attempt_id": command["attempt_id"], "lease_owner": command["lease_owner"], **extra,
    })


def image_receipts(command):
    return [{"asset_id": asset["asset_id"], "sha256": asset["sha256"],
             "remote_url": f"https://postfiles.pstatic.net/contract-fixture/{asset['sha256']}.png"}
            for asset in command["assets"]]


def reach_saved_checkpoint(client, command):
    for stage in ("browser_attach", "health_check", "prepare_editor", "input_title",
                  "input_body", "upload_images", "input_tags", "draft_save"):
        for status in ("running", "passed"):
            verification = {"image_receipts": image_receipts(command)} if stage == "upload_images" and status == "passed" else None
            response = event(client, command, stage, status, verification=verification)
            assert response.status_code == 200, response.text


def verification(command):
    return {
        "actual_title_hash": command["title_hash"], "actual_body_hash": command["body_hash"],
        "body_chars": command["body_chars"], "image_count": 3, "remote_image_count": 3,
        "asset_manifest_hash": command["asset_manifest_hash"],
        "image_receipts": image_receipts(command), "actual_tags": command["tags"],
    }


def test_http_isolated_full_contract_and_idempotency(isolated_publish):
    client, draft_id, sessions, _ = isolated_publish
    first = start(client, draft_id)
    assert start(client, draft_id)["job_id"] == first["job_id"]
    command = claim(client)
    assert command["resume_stage"] == "browser_attach"
    assert command["attempt_id"] and command["lease_owner"]
    assert claim(client, "second-worker") is None
    reach_saved_checkpoint(client, command)
    assert event(client, command, "reopen_verify", "running").status_code == 200
    result = event(client, command, "reopen_verify", "passed", verification=verification(command))
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "verified_draft_saved"
    assert claim(client) is None
    with sessions() as session:
        assert session.query(PublishJob).count() == 1


def test_http_retry_preserves_reopen_checkpoint_and_rejects_old_attempt(isolated_publish):
    client, draft_id, _, _ = isolated_publish
    job = start(client, draft_id)
    first = claim(client)
    reach_saved_checkpoint(client, first)
    assert event(client, first, "reopen_verify", "running").status_code == 200
    assert event(client, first, "reopen_verify", "failed", error_code="fixture_reopen_failure").status_code == 200
    retried = client.post(f"/v1/publish-jobs/{job['job_id']}/retry")
    assert retried.status_code == 200
    second = claim(client)
    assert second["resume_stage"] == "reopen_verify"
    assert second["attempt_id"] != first["attempt_id"]
    assert second["image_receipts"] == image_receipts(first)
    stale = event(client, first, "reopen_verify", "passed", verification=verification(first))
    assert stale.status_code == 409
    assert event(client, second, "reopen_verify", "running").status_code == 200
    result = event(client, second, "reopen_verify", "passed", verification=verification(second))
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "verified_draft_saved"


@pytest.mark.parametrize("mismatch", ["image", "tag", "body"])
def test_http_same_counts_do_not_hide_wrong_content(isolated_publish, mismatch):
    client, draft_id, _, _ = isolated_publish
    start(client, draft_id)
    command = claim(client)
    reach_saved_checkpoint(client, command)
    assert event(client, command, "reopen_verify", "running").status_code == 200
    values = verification(command)
    if mismatch == "image":
        values["image_receipts"][0]["remote_url"] = "https://postfiles.pstatic.net/wrong.png"
    elif mismatch == "tag":
        values["actual_tags"] = ["다른태그"]
    else:
        values["actual_body_hash"] = "0" * 64
    response = event(client, command, "reopen_verify", "passed", verification=values)
    assert response.status_code in (200, 409)
    current = client.get(f"/v1/publish-jobs/{command['job_id']}").json()
    assert current["status"] != "verified_draft_saved"


def test_http_active_job_blocks_asset_deletion(isolated_publish):
    client, draft_id, _, assets = isolated_publish
    start(client, draft_id)
    asset = assets.list(draft_id, 1)[0]
    response = client.delete(f"/v1/drafts/{draft_id}/assets/{asset['asset_id']}")
    assert response.status_code == 409, response.text
    assert len(assets.list(draft_id, 1)) == 3


def test_http_tampered_file_is_not_downloaded(isolated_publish):
    client, draft_id, _, assets = isolated_publish
    job = start(client, draft_id)
    row = assets.get_row(assets.list(draft_id, 1)[0]["asset_id"])
    from pathlib import Path
    Path(row.local_path).write_bytes(b"changed-after-job-created")
    response = client.get(f"/v1/publish-jobs/{job['job_id']}/assets/{row.id}")
    assert response.status_code == 409, response.text


@pytest.mark.parametrize("body_chars,image_count,expected", [
    (2999, 3, 422), (3000, 3, 202), (3000, 2, 422), (3001, 2, 422),
])
def test_http_strict_size_boundaries(isolated_publish, body_chars, image_count, expected):
    client, draft_id, sessions, assets = isolated_publish
    with sessions() as session:
        version = session.query(DraftVersion).filter_by(draft_id=draft_id, version=1).one()
        version.body = "가" * body_chars
        session.commit()
    if image_count == 2:
        assets.delete(draft_id, assets.list(draft_id, 1)[0]["asset_id"])
    response = client.post(f"/v1/drafts/{draft_id}/publish-jobs", json={
        "blog_id": "contract_blog", "tags": [], "expected_version": 1,
        "transport": "current_chrome_extension", "target_worker_id": "fixture-worker",
    })
    assert response.status_code == expected, response.text
    with sessions() as session:
        assert session.query(PublishJob).count() == (1 if expected == 202 else 0)


def test_http_body_checkpoint_resumes_images_and_rejects_retyping(isolated_publish):
    client, draft_id, _, _ = isolated_publish
    job = start(client, draft_id)
    first = claim(client)
    for stage in ('browser_attach', 'health_check', 'prepare_editor', 'input_title', 'input_body'):
        assert event(client, first, stage, 'passed').status_code == 200
    assert event(client, first, 'upload_images', 'failed', error_code='image_caret_unconfirmed').status_code == 200
    assert client.post(f"/v1/publish-jobs/{job['job_id']}/retry").status_code == 200
    second = claim(client)
    assert second['resume_stage'] == 'upload_images'
    assert event(client, second, 'input_title', 'passed').status_code == 409
    assert event(client, first, 'upload_images', 'running').status_code == 409
    assert event(client, second, 'upload_images', 'running').status_code == 200
