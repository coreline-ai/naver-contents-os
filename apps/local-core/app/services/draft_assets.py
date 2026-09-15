"""Versioned, local-only image assets used by verified draft-save jobs."""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import re
import struct
import zlib
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.config import DATA_DIR
from app.models_db import Draft, DraftAsset, DraftVersion

MAX_ASSET_BYTES = 12 * 1024 * 1024
MAX_ASSETS_PER_VERSION = 10
ASSET_ROOT = DATA_DIR / "draft-assets"
ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp"}
EXTENSION_BY_MIME = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def _png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


class _Canvas:
    """Tiny dependency-free raster canvas for original guide illustrations."""

    def __init__(self, width: int, height: int, color: tuple[int, int, int]):
        self.width = width
        self.height = height
        self.pixels = bytearray(color * (width * height))

    def rectangle(self, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        x0, x1 = max(0, x0), min(self.width, x1)
        y0, y1 = max(0, y0), min(self.height, y1)
        row = bytes(color) * max(0, x1 - x0)
        for y in range(y0, y1):
            start = (y * self.width + x0) * 3
            self.pixels[start:start + len(row)] = row

    def circle(self, cx: int, cy: int, radius: int, color: tuple[int, int, int]) -> None:
        radius2 = radius * radius
        for y in range(max(0, cy - radius), min(self.height, cy + radius + 1)):
            dy2 = (y - cy) ** 2
            span = int(max(0, radius2 - dy2) ** 0.5)
            self.rectangle(cx - span, y, cx + span + 1, y + 1, color)

    def line(self, x0: int, y0: int, x1: int, y1: int, width: int, color: tuple[int, int, int]) -> None:
        steps = max(abs(x1 - x0), abs(y1 - y0), 1)
        for step in range(steps + 1):
            x = round(x0 + (x1 - x0) * step / steps)
            y = round(y0 + (y1 - y0) * step / steps)
            self.circle(x, y, max(1, width // 2), color)

    def png(self) -> bytes:
        rows = b"".join(
            b"\x00" + bytes(self.pixels[y * self.width * 3:(y + 1) * self.width * 3])
            for y in range(self.height)
        )
        header = struct.pack(">IIBBBBB", self.width, self.height, 8, 2, 0, 0, 0)
        return b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", header) + _png_chunk(b"IDAT", zlib.compress(rows, 9)) + _png_chunk(b"IEND", b"")


def _generated_guide_png(keyword: str, variant: int) -> bytes:
    """Create one original, text-free editorial illustration for the draft."""
    digest = hashlib.sha256(f"{keyword}:{variant}".encode("utf-8")).digest()
    accent = (150 + digest[0] % 80, 70 + digest[1] % 100, 70 + digest[2] % 100)
    dark = (40 + digest[3] % 45, 45 + digest[4] % 45, 55 + digest[5] % 45)
    cream = (251, 247, 238)
    mint = (116, 190, 160)
    gold = (237, 184, 72)
    canvas = _Canvas(1200, 800, cream)
    canvas.rectangle(0, 0, 1200, 120, dark)
    canvas.rectangle(0, 720, 1200, 800, dark)

    if variant % 3 == 0:
        canvas.rectangle(280, 310, 920, 650, accent)
        canvas.rectangle(245, 255, 955, 345, dark)
        canvas.rectangle(555, 255, 645, 650, gold)
        canvas.circle(530, 245, 78, mint)
        canvas.circle(670, 245, 78, mint)
        canvas.circle(600, 250, 42, gold)
        for i, (x, y) in enumerate(((160, 210), (1030, 190), (170, 610), (1040, 590), (95, 400), (1110, 390))):
            canvas.circle(x, y, 14 + (digest[i + 6] % 18), gold if i % 2 else mint)
    elif variant % 3 == 1:
        for i, y in enumerate((220, 380, 540)):
            canvas.rectangle(210, y, 990, y + 115, (255, 255, 255))
            canvas.circle(285, y + 57, 34, mint if i < 2 else accent)
            canvas.line(270, y + 58, 283, y + 72, 12, cream)
            canvas.line(283, y + 72, 307, y + 42, 12, cream)
            canvas.rectangle(360, y + 35, 800 - i * 65, y + 52, dark)
            canvas.rectangle(360, y + 70, 900 - i * 80, y + 83, (194, 199, 202))
    else:
        canvas.rectangle(135, 455, 350, 620, accent)
        canvas.rectangle(220, 455, 265, 620, gold)
        canvas.rectangle(115, 420, 370, 480, dark)
        canvas.rectangle(890, 390, 1080, 620, mint)
        canvas.line(860, 405, 985, 285, 36, dark)
        canvas.line(985, 285, 1110, 405, 36, dark)
        canvas.rectangle(965, 515, 1015, 620, dark)
        points = ((385, 515), (500, 430), (610, 500), (720, 390), (840, 470))
        previous = (350, 515)
        for point in points:
            canvas.line(previous[0], previous[1], point[0], point[1], 12, gold)
            canvas.circle(point[0], point[1], 15, accent)
            previous = point
    return canvas.png()


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
        """Fill the current version with up to three app-created guide images."""
        target_count = max(1, min(3, count))
        with self._sessions() as session:
            draft = session.get(Draft, draft_id)
            if draft is None:
                raise ValueError("draft not found")
            version_exists = session.scalar(
                select(DraftVersion.id).where(
                    DraftVersion.draft_id == draft_id,
                    DraftVersion.version == draft_version,
                )
            )
            if version_exists is None:
                raise ValueError("draft version not found")
            from app.models_db import Keyword
            keyword = session.get(Keyword, draft.keyword_id)
            topic = keyword.text if keyword is not None else f"draft-{draft_id}"

        existing = self.list(draft_id, draft_version)
        used_positions = {item["position"] for item in existing}
        for variant in range(len(existing), target_count):
            position = next(value for value in range(MAX_ASSETS_PER_VERSION) if value not in used_positions)
            data = _generated_guide_png(topic, variant)
            self.add(
                draft_id,
                draft_version=draft_version,
                filename=f"app-guide-{variant + 1}.png",
                mime_type="image/png",
                data_base64=base64.b64encode(data).decode("ascii"),
                position=position,
                anchor_after=(variant + 1) * 3,
                rights_status="approved",
            )
            used_positions.add(position)
        return self.list(draft_id, draft_version)

    def manifest_version(self, draft_id: int, draft_version: int) -> int:
        with self._sessions() as session:
            return int(session.scalar(
                select(func.max(DraftAsset.id)).where(
                    DraftAsset.draft_id == draft_id,
                    DraftAsset.draft_version == draft_version,
                )
            ) or 0)

    def get_row(self, asset_id: int) -> DraftAsset | None:
        with self._sessions() as session:
            row = session.get(DraftAsset, asset_id)
            if row is None:
                return None
            session.expunge(row)
            return row

    def delete(self, draft_id: int, asset_id: int) -> bool:
        path: Path | None = None
        with self._sessions() as session:
            row = session.get(DraftAsset, asset_id)
            if row is None or row.draft_id != draft_id:
                return False
            path = Path(row.local_path)
            session.delete(row)
            session.commit()
        if path is not None and path.is_relative_to(self._root):
            path.unlink(missing_ok=True)
        return True
