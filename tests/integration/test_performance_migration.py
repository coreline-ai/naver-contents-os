"""Exercise actual Alembic upgrades, not just metadata.create_all."""
from datetime import date, datetime, timezone
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from app.db import make_engine, make_session_factory
from app.models_db import Draft, DraftVersion, Keyword, PublishedContent
from app.services.performance import PerformanceService


def test_performance_upgrade_and_rollback_preserve_existing_drafts(tmp_path):
    root = Path(__file__).resolve().parents[2]
    path = tmp_path / "migration.db"
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{path}")
    command.upgrade(config, "e8c1f4a9b7d2")
    engine = make_engine(path)
    sessions = make_session_factory(engine)
    with sessions() as session:
        keyword = Keyword(text="마이그레이션 검증용")
        session.add(keyword)
        session.flush()
        draft = Draft(keyword_id=keyword.id, title="보존 원고", blog_type="HOWTO")
        session.add(draft)
        session.flush()
        session.add(DraftVersion(draft_id=draft.id, version=1, title=draft.title, body="원문 보존 확인"))
        session.add(PublishedContent(keyword_id=keyword.id, draft_id=draft.id, title=draft.title,
                                     canonical_url="https://example.com/probe", published_at=datetime.now(timezone.utc)))
        session.commit()
    command.upgrade(config, "head")
    service = PerformanceService(sessions)
    channel = service.create_channel(source="creator_advisor", display_name="migration probe")
    imported = service.create_import(channel_id=channel["id"], source="creator_advisor", data_kind="content_performance",
                                     period_start=date(2026, 8, 24), period_end=date(2026, 8, 30), grain="weekly",
                                     rows=[{"canonical_url": "https://example.com/probe", "impressions": 1000, "inflows": 1}])
    assert service.contents()["items"][0]["published_content_id"] is not None
    assert service.delete_import(imported["id"])
    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA foreign_key_check")).all() == []
        assert conn.scalar(text("SELECT COUNT(*) FROM content_performance_snapshots")) == 0
        assert conn.scalar(text("SELECT COUNT(*) FROM performance_recommendations")) == 0
    command.downgrade(config, "e8c1f4a9b7d2")
    assert "owned_channels" not in inspect(engine).get_table_names()
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT body FROM draft_versions")) == "원문 보존 확인"
        assert conn.scalar(text("SELECT COUNT(*) FROM published_contents")) == 1
    command.upgrade(config, "head")
    with engine.connect() as conn:
        assert conn.scalar(text("SELECT version_num FROM alembic_version")) == "c7a4e91d2f60"
        assert conn.execute(text("PRAGMA foreign_key_check")).all() == []
        assert conn.scalar(text("SELECT body FROM draft_versions")) == "원문 보존 확인"
    engine.dispose()
