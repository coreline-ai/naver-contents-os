from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.db import make_engine, make_session_factory
from app.models_db import Base, PublishedContent
from app.services.drafts import DraftService, SqlJobStore
from app.services.published import (
    PublishedContentService,
    build_content_state_index,
    normalize_public_url,
    publication_state,
)


PLAN = {
    "order": 1,
    "title": "공개할 글",
    "blog_type": "HOWTO",
    "target_keyword": "공개 키워드",
    "angle": "",
}


@pytest.fixture
def sessions(tmp_path):
    engine = make_engine(tmp_path / "published.db")
    Base.metadata.create_all(engine)
    return make_session_factory(engine)


def test_publication_requires_user_confirmation_and_never_follows_draft_save_automatically(sessions):
    draft = DraftService(sessions, None).create_draft("공개 키워드", PLAN)
    store = SqlJobStore(sessions)
    job_id = store.create(draft["draft_id"])
    store.update(
        job_id,
        status="draft_saved",
        stage="draft_save",
        error_code=None,
        detail="",
        history_entry={"stage": "draft_save", "status": "draft_saved", "at": "test"},
    )
    with sessions() as session:
        assert session.query(PublishedContent).count() == 0

    service = PublishedContentService(sessions)
    with pytest.raises(ValueError, match="confirmation"):
        service.create(
            draft_id=draft["draft_id"],
            keyword_text="",
            canonical_url="https://blog.naver.com/test/1",
            title="공개 글",
            published_at=datetime.now(timezone.utc),
            confirmed=False,
        )
    created = service.create(
        draft_id=draft["draft_id"],
        keyword_text="",
        canonical_url="HTTPS://BLOG.NAVER.COM/test/1/#fragment",
        title="공개 글",
        published_at=datetime.now(timezone.utc),
        confirmed=True,
    )
    assert created["canonical_url"] == "https://blog.naver.com/test/1"
    assert created["state"] == "published"
    with sessions() as session:
        state = build_content_state_index(session)["공개키워드"]
    assert state["state"] == "published"
    assert state["draft_count"] == 1


def test_publication_validates_url_duplicates_future_dates_and_archive_state(sessions):
    service = PublishedContentService(sessions)
    now = datetime.now(timezone.utc)
    created = service.create(
        draft_id=None,
        keyword_text="수동 등록",
        canonical_url="https://example.com/post/",
        title="수동 글",
        published_at=now - timedelta(days=90),
        confirmed=True,
    )
    with sessions() as session:
        row = session.get(PublishedContent, created["id"])
        assert publication_state(row, now=now) == "stale"
    with pytest.raises(ValueError, match="http or https"):
        service.create(
            draft_id=None,
            keyword_text="수동 등록",
            canonical_url="javascript:alert(1)",
            title="잘못된 글",
            published_at=now,
            confirmed=True,
        )
    with pytest.raises(ValueError, match="future"):
        service.create(
            draft_id=None,
            keyword_text="미래 글",
            canonical_url="https://example.com/future",
            title="미래 글",
            published_at=now + timedelta(days=1),
            confirmed=True,
        )
    with pytest.raises(ValueError, match="already registered"):
        service.create(
            draft_id=None,
            keyword_text="다른 키워드",
            canonical_url="https://example.com/post#other",
            title="중복 글",
            published_at=now,
            confirmed=True,
        )
    archived = service.update(created["id"], archived=True)
    assert archived["state"] == "archived"
    assert service.list()["items"] == []
    assert service.list(include_archived=True)["items"][0]["state"] == "archived"
    restored = service.update(created["id"], archived=False)
    assert restored["state"] == "stale"


def test_normalize_public_url_removes_default_port_and_fragment():
    assert normalize_public_url("https://Example.COM:443/a/?x=1#frag") == "https://example.com/a?x=1"


@pytest.fixture
def published_api(tmp_path, monkeypatch):
    token = "published-api-token"
    monkeypatch.setenv("DB_PATH", str(tmp_path / "api.db"))
    monkeypatch.setenv("LOCAL_CORE_TOKEN", token)
    from app import deps
    from app.main import create_app

    deps.reset_caches()
    yield TestClient(create_app()), token, deps.get_session_factory()
    deps.reset_caches()


def test_published_content_api_create_list_and_archive(published_api):
    client, token, sessions = published_api
    draft = DraftService(sessions, None).create_draft("API 공개", PLAN)
    headers = {"X-Local-Token": token}
    created = client.post(
        "/v1/published-contents",
        headers=headers,
        json={
            "draft_id": draft["draft_id"],
            "canonical_url": "https://blog.naver.com/test/2",
            "title": "API 공개 글",
            "published_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
            "confirmed": True,
        },
    )
    assert created.status_code == 201
    listed = client.get("/v1/published-contents?query=API", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["items"][0]["keyword"] == "API 공개"
    archived = client.patch(
        f"/v1/published-contents/{created.json()['id']}",
        headers=headers,
        json={"archived": True},
    )
    assert archived.status_code == 200
    assert archived.json()["state"] == "archived"


def test_published_content_api_rejects_unconfirmed_and_duplicate(published_api):
    client, token, _ = published_api
    headers = {"X-Local-Token": token}
    payload = {
        "keyword": "중복",
        "canonical_url": "https://example.com/duplicate",
        "title": "중복 글",
        "published_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        "confirmed": False,
    }
    assert client.post("/v1/published-contents", headers=headers, json=payload).status_code == 422
    payload["confirmed"] = True
    assert client.post("/v1/published-contents", headers=headers, json=payload).status_code == 201
    assert client.post("/v1/published-contents", headers=headers, json=payload).status_code == 409
