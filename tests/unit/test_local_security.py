from __future__ import annotations

import stat

from sqlalchemy import text

from app.config import Settings
from app.db import make_engine


def _mode(path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_generated_local_token_is_persisted_with_owner_only_permissions(tmp_path, monkeypatch):
    import app.config as config

    data_dir = tmp_path / "data"
    token_file = data_dir / "local_core_token.txt"
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "TOKEN_FILE", token_file)

    settings = Settings(_env_file=None)
    token = settings.resolve_token()

    assert token_file.read_text(encoding="utf-8").strip() == token
    assert _mode(token_file) == 0o600
    assert settings.resolve_token() == token


def test_existing_token_permissions_are_repaired(tmp_path, monkeypatch):
    import app.config as config

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    token_file = data_dir / "local_core_token.txt"
    token_file.write_text("existing-token\n", encoding="utf-8")
    token_file.chmod(0o644)
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(config, "TOKEN_FILE", token_file)

    assert Settings(_env_file=None).resolve_token() == "existing-token"
    assert _mode(token_file) == 0o600


def test_sqlite_file_is_owner_only(tmp_path):
    path = tmp_path / "private.db"
    engine = make_engine(path)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE sample (id INTEGER PRIMARY KEY)"))

    assert _mode(path) == 0o600
