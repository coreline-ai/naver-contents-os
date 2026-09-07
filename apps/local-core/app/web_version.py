"""Non-secret runtime fingerprint, frozen by main.create_app at startup."""
import hashlib
from app.config import ROOT_DIR, get_settings


def runtime_revision() -> str:
    digest = hashlib.sha256()
    settings = get_settings()
    digest.update(f"{settings.db_path.resolve()}|{settings.web_origin}|{settings.web_build_dir.resolve()}".encode())
    paths = [*ROOT_DIR.joinpath('apps/local-core/app').rglob('*.py'), *ROOT_DIR.joinpath('python').rglob('*.py'), *ROOT_DIR.joinpath('alembic/versions').glob('*.py')]
    paths += [settings.web_build_dir / 'index.html', settings.web_build_dir / 'theme-init.js']
    for path in sorted(paths):
        if path.is_file():
            digest.update(str(path.relative_to(ROOT_DIR) if path.is_relative_to(ROOT_DIR) else path.name).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:20]
