"""Versioned, local-only image assets used by verified draft-save jobs."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
from pathlib import Path

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import DATA_DIR
from app.models_db import Draft, DraftAsset, DraftVersion, PublishJob
from app.services.guide_cards import excerpt_cards, korean_font_path, render_card

MAX_ASSET_BYTES = 12 * 1024 * 1024
MAX_ASSETS_PER_VERSION = 10
ASSET_ROOT = DATA_DIR / "draft-assets"
ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp"}
EXTENSION_BY_MIME = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def _safe_name(value: str, suffix: str) -> str:
    stem = Path(value).stem[:120]
    stem = re.sub(r"[^0-9A-Za-z가-힣._-]+", "-", stem).strip(".-") or "image"
    return f"{stem}{suffix}"


def _detect_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _view(asset: DraftAsset) -> dict:
    return {
        "asset_id": asset.id,
        "draft_id": asset.draft_id,
        "draft_version": asset.draft_version,
        "filename": asset.filename,
        "mime_type": asset.mime_type,
        "byte_size": asset.byte_size,
        "sha256": asset.sha256,
        "position": asset.position,
        "anchor_after": asset.anchor_after,
        "rights_status": asset.rights_status,
        "created_at": asset.created_at.isoformat() if asset.created_at else None,
    }


MANIFEST_FIELDS = ("asset_id", "sha256", "position", "anchor_after", "rights_status", "byte_size", "mime_type", "filename")


def asset_snapshot(assets: list[dict]) -> list[dict]:
    return [{key: asset[key] for key in MANIFEST_FIELDS} for asset in assets]


def asset_manifest_hash(snapshot: list[dict]) -> str:
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _require_mutable(session: Session, draft_id: int, draft_version: int) -> None:
    active = session.scalar(select(PublishJob.id).where(
        PublishJob.draft_id == draft_id, PublishJob.draft_version == draft_version,
        PublishJob.status.in_(("pending", "waiting_extension", "running")),
    ))
    if active is not None:
        raise ValueError("image assets are locked by an active publish job")


class DraftAssetService:
    def __init__(self, session_factory: sessionmaker[Session], root: Path = ASSET_ROOT):
        self._sessions = session_factory
        self._root = root

    def add(
        self,
        draft_id: int,
        *,
        draft_version: int,
        filename: str,
        mime_type: str,
        data_base64: str,
        position: int,
        anchor_after: int,
        rights_status: str,
    ) -> dict:
        if mime_type not in ALLOWED_MIME:
            raise ValueError("unsupported image type")
        if rights_status != "approved":
            raise ValueError("image rights approval is required")
        if not 0 <= position < MAX_ASSETS_PER_VERSION:
            raise ValueError("asset position must be between 0 and 9")
        if not 0 <= anchor_after <= 1000:
            raise ValueError("asset anchor must be between 0 and 1000")
        encoded = data_base64.split(",", 1)[-1] if data_base64.startswith("data:") else data_base64
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("invalid base64 image") from exc
        if not data or len(data) > MAX_ASSET_BYTES:
            raise ValueError("image must be between 1 byte and 12 MB")
        detected = _detect_mime(data)
        if detected != mime_type:
            raise ValueError("image content does not match mime type")

        digest = hashlib.sha256(data).hexdigest()
        suffix = EXTENSION_BY_MIME[mime_type]
        safe_filename = _safe_name(filename, suffix)
        target_dir = self._root / str(draft_id) / f"v{draft_version}"
        target_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        target_dir.chmod(0o700)
        target = target_dir / f"{digest}{suffix}"

        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            _require_mutable(session, draft_id, draft_version)
            if session.get(Draft, draft_id) is None:
                raise ValueError("draft not found")
            version_exists = session.scalar(
                select(DraftVersion.id).where(
                    DraftVersion.draft_id == draft_id,
                    DraftVersion.version == draft_version,
                )
            )
            if version_exists is None:
                raise ValueError("draft version not found")
            count = session.scalar(
                select(func.count(DraftAsset.id)).where(
                    DraftAsset.draft_id == draft_id,
                    DraftAsset.draft_version == draft_version,
                )
            ) or 0
            if count >= MAX_ASSETS_PER_VERSION:
                raise ValueError("a draft version supports at most 10 images")

            wrote = False
            if not target.exists():
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                wrote = True
            asset = DraftAsset(
                draft_id=draft_id,
                draft_version=draft_version,
                filename=safe_filename,
                local_path=str(target),
                mime_type=mime_type,
                byte_size=len(data),
                sha256=digest,
                position=position,
                anchor_after=anchor_after,
                rights_status=rights_status,
            )
            session.add(asset)
            try:
                session.commit()
            except IntegrityError as exc:
                session.rollback()
                if wrote:
                    target.unlink(missing_ok=True)
                raise ValueError("image position or content is already registered") from exc
            session.refresh(asset)
            return _view(asset)

    def list(self, draft_id: int, draft_version: int) -> list[dict]:
        with self._sessions() as session:
            rows = session.scalars(
                select(DraftAsset).where(
                    DraftAsset.draft_id == draft_id,
                    DraftAsset.draft_version == draft_version,
                ).order_by(DraftAsset.position, DraftAsset.id)
            ).all()
            return [_view(row) for row in rows]

    def generate_guide_set(self, draft_id: int, draft_version: int, count: int = 3) -> list[dict]:
        """Fill missing slots with excerpts from the saved version; never replace old assets."""
        target_count = max(1, min(3, count))
        with self._sessions() as session:
            _require_mutable(session, draft_id, draft_version)
            if session.get(Draft, draft_id) is None:
                raise ValueError("draft not found")
            version = session.scalar(select(DraftVersion).where(
                DraftVersion.draft_id == draft_id, DraftVersion.version == draft_version,
            ))
            if version is None:
                raise ValueError("draft version not found")
            title, body = version.title, version.body
        existing = self.list(draft_id, draft_version)
        if len(existing) >= target_count:
            return existing
        cards = excerpt_cards(title, body, target_count)
        font_path = korean_font_path()
        used_positions = {item["position"] for item in existing}
        used_anchors = {item["anchor_after"] for item in existing}
        # Prefer the removed card's source paragraph on retries, not a duplicate of the last card.
        candidates = sorted(enumerate(cards), key=lambda pair: pair[1].anchor_after in used_anchors)
        prepared = [(card, render_card(card, index + 1, font_path))
                    for index, card in candidates[:target_count - len(existing)]]
        for card, data in prepared:
            position = next(value for value in range(MAX_ASSETS_PER_VERSION) if value not in used_positions)
            self.add(
                draft_id, draft_version=draft_version,
                filename=f"body-excerpt-p{card.anchor_after}.png", mime_type="image/png",
                data_base64=base64.b64encode(data).decode("ascii"), position=position,
                anchor_after=card.anchor_after, rights_status="approved",
            )
            used_positions.add(position)
        return self.list(draft_id, draft_version)

    def manifest_version(self, draft_id: int, draft_version: int) -> int:
        # Retain the integer contract, but detect deletion/reordering as well
        # as additions. The full hash/snapshot is authoritative for jobs.
        digest = asset_manifest_hash(asset_snapshot(self.list(draft_id, draft_version)))
        return int(digest[:7], 16)

    def get_row(self, asset_id: int) -> DraftAsset | None:
        with self._sessions() as session:
            row = session.get(DraftAsset, asset_id)
            if row is None:
                return None
            session.expunge(row)
            return row

    def verify_file(self, asset_id: int) -> DraftAsset:
        row = self.get_row(asset_id)
        if row is None:
            raise ValueError("pinned image file is unavailable")
        path = Path(row.local_path)
        try:
            if path.is_symlink() or not path.resolve().is_relative_to(self._root.resolve()):
                raise ValueError("pinned image file is outside the asset store")
            data = path.read_bytes()
        except OSError as exc:
            raise ValueError("pinned image file is unavailable") from exc
        if len(data) != row.byte_size or hashlib.sha256(data).hexdigest() != row.sha256:
            raise ValueError("pinned image file integrity check failed")
        return row

    def delete(self, draft_id: int, asset_id: int) -> bool:
        path: Path | None = None
        with self._sessions() as session:
            session.execute(text("BEGIN IMMEDIATE"))
            row = session.get(DraftAsset, asset_id)
            if row is None or row.draft_id != draft_id:
                return False
            _require_mutable(session, draft_id, row.draft_version)
            path = Path(row.local_path)
            # Keep file removal under the same writer lock: a concurrent
            # re-add of this content-addressed blob must not be unlinked.
            if path.is_relative_to(self._root):
                try:
                    path.unlink(missing_ok=True)
                except OSError as exc:
                    raise ValueError("image file removal failed") from exc
            session.delete(row)
            session.commit()
        return True
