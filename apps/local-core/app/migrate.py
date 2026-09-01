from __future__ import annotations

from alembic import command
from alembic.config import Config

from app.config import ROOT_DIR, get_settings


def upgrade_to_head() -> None:
    cfg = Config(str(ROOT_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT_DIR / "alembic"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{get_settings().db_path}")
    command.upgrade(cfg, "head")
    db_path = get_settings().db_path
    if db_path.exists():
        db_path.chmod(0o600)
