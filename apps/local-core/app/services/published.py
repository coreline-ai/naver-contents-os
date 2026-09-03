"""User-confirmed public content registry and shared content-state resolver."""

from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import Draft, DraftVersion, Keyword, PublishedContent
from intelligence.keyword.models import compact, normalize_keyword


STALE_DAYS = 90


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return _as_utc(value).isoformat() if value is not None else None


def normalize_public_url(value: str) -> str:
    try:
        parts = urlsplit(value.strip())
    except ValueError as exc:
        raise ValueError("published URL is invalid") from exc
    scheme = parts.scheme.casefold()
    if scheme not in {"http", "https"} or not parts.hostname:
        raise ValueError("published URL must use http or https")
    if parts.username or parts.password:
        raise ValueError("published URL must not contain credentials")
    hostname = parts.hostname.casefold()
    try:
        port = parts.port
    except ValueError as exc:
        raise ValueError("published URL port is invalid") from exc
    netloc = hostname
    if port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    ):
        netloc = f"{netloc}:{port}"
    path = parts.path or "/"
    if path != "/":
        path = path.rstrip("/") or "/"
    return urlunsplit((scheme, netloc, path, parts.query, ""))


def publication_state(row: PublishedContent, *, now: datetime | None = None) -> str:
    if row.archived_at is not None:
        return "archived"
    reference = _as_utc(row.published_at)
    return "stale" if ((_as_utc(now or _utcnow()) - reference).days >= STALE_DAYS) else "published"


def build_content_state_index(session: Session, *, now: datetime | None = None) -> dict[str, dict]:
    """Return one deterministic content state per normalized keyword without external calls."""
    now = now or _utcnow()
    latest_versions = (
        select(
            Draft.keyword_id.label("keyword_id"),
            func.count(func.distinct(Draft.id)).label("draft_count"),
            func.max(DraftVersion.created_at).label("last_draft_at"),
        )
        .join(DraftVersion, DraftVersion.draft_id == Draft.id)
        .group_by(Draft.keyword_id)
        .subquery()
    )
    rows = session.execute(
        select(Keyword, latest_versions.c.draft_count, latest_versions.c.last_draft_at)
        .outerjoin(latest_versions, latest_versions.c.keyword_id == Keyword.id)
    ).all()
    publications = session.scalars(
        select(PublishedContent).order_by(PublishedContent.published_at.desc(), PublishedContent.id.desc())
    ).all()
    by_keyword: dict[int, list[PublishedContent]] = {}
    for publication in publications:
        by_keyword.setdefault(publication.keyword_id, []).append(publication)

    result: dict[str, dict] = {}
    for keyword, draft_count, last_draft_at in rows:
        public_rows = by_keyword.get(keyword.id, [])
        active = next((row for row in public_rows if row.archived_at is None), None)
        archived = next((row for row in public_rows if row.archived_at is not None), None)
        if active is not None:
            state = publication_state(active, now=now)
            public = active
        elif archived is not None:
            state = "archived"
            public = archived
        elif draft_count:
            state = "draft_only"
            public = None
        else:
            state = "missing"
            public = None
        result[compact(keyword.text).casefold()] = {
            "state": state,
            "draft_count": int(draft_count or 0),
            "last_draft_at": _iso(last_draft_at),
            "published_content_id": public.id if public is not None else None,
            "published_url": public.canonical_url if public is not None else None,
            "published_at": _iso(public.published_at) if public is not None else None,
        }
    return result


class PublishedContentService:
    def __init__(self, session_factory: sessionmaker[Session]):
        self._sessions = session_factory

    @staticmethod
    def _view(row: PublishedContent, keyword: str, draft_count: int, *, now: datetime | None = None) -> dict:
        return {
            "id": row.id,
            "draft_id": row.draft_id,
            "keyword": keyword,
            "title": row.title,
            "canonical_url": row.canonical_url,
            "published_at": _iso(row.published_at),
            "verified_at": _iso(row.verified_at),
            "archived_at": _iso(row.archived_at),
            "state": publication_state(row, now=now),
            "draft_count": draft_count,
        }

    def create(
        self,
        *,
        canonical_url: str,
        title: str,
        published_at: datetime,
        confirmed: bool,
        draft_id: int | None = None,
        keyword_text: str = "",
    ) -> dict:
        if not confirmed:
            raise ValueError("explicit publication confirmation is required")
        normalized_title = title.strip()
        if not normalized_title:
            raise ValueError("published title is required")
        normalized_url = normalize_public_url(canonical_url)
        published_at = _as_utc(published_at)
        if published_at > _utcnow():
            raise ValueError("published_at must not be in the future")

        with self._sessions() as session:
            draft = session.get(Draft, draft_id) if draft_id is not None else None
            if draft_id is not None and draft is None:
                raise ValueError("draft not found")
            if draft is not None:
                keyword = session.get(Keyword, draft.keyword_id)
                if keyword is None:
                    raise ValueError("draft keyword not found")
                normalized_keyword = normalize_keyword(keyword_text) if keyword_text else keyword.text
                if compact(normalized_keyword).casefold() != compact(keyword.text).casefold():
                    raise ValueError("published keyword does not match draft")
            else:
                normalized_keyword = normalize_keyword(keyword_text)
                if not normalized_keyword:
                    raise ValueError("keyword is required when draft_id is absent")
                keyword = session.scalar(select(Keyword).where(Keyword.text == normalized_keyword))
                if keyword is None:
                    keyword = Keyword(text=normalized_keyword)
                    session.add(keyword)
                    session.flush()
            row = PublishedContent(
                draft_id=draft_id,
                keyword_id=keyword.id,
                canonical_url=normalized_url,
                title=normalized_title,
                published_at=published_at,
                verified_at=_utcnow(),
            )
            session.add(row)
            try:
                session.commit()
            except IntegrityError as exc:
                session.rollback()
                raise ValueError("published URL or draft is already registered") from exc
            draft_count = session.scalar(
                select(func.count(Draft.id)).where(Draft.keyword_id == keyword.id)
            ) or 0
            return self._view(row, keyword.text, int(draft_count))

    def list(self, *, query: str = "", include_archived: bool = False) -> dict:
        stmt = (
            select(PublishedContent, Keyword, func.count(Draft.id))
            .join(Keyword, Keyword.id == PublishedContent.keyword_id)
            .outerjoin(Draft, Draft.keyword_id == Keyword.id)
            .group_by(PublishedContent.id, Keyword.id)
        )
        if not include_archived:
            stmt = stmt.where(PublishedContent.archived_at.is_(None))
        normalized_query = query.strip().casefold()
        if normalized_query:
            needle = f"%{normalized_query}%"
            stmt = stmt.where(
                or_(
                    func.lower(Keyword.text).like(needle),
                    func.lower(PublishedContent.title).like(needle),
                    func.lower(PublishedContent.canonical_url).like(needle),
                )
            )
        stmt = stmt.order_by(PublishedContent.published_at.desc(), PublishedContent.id.desc())
        with self._sessions() as session:
            rows = session.execute(stmt).all()
            return {
                "items": [self._view(row, keyword.text, int(count or 0)) for row, keyword, count in rows]
            }

    def update(
        self,
        content_id: int,
        *,
        title: str | None = None,
        published_at: datetime | None = None,
        archived: bool | None = None,
    ) -> dict | None:
        with self._sessions() as session:
            row = session.get(PublishedContent, content_id)
            if row is None:
                return None
            if title is not None:
                normalized_title = title.strip()
                if not normalized_title:
                    raise ValueError("published title is required")
                row.title = normalized_title
            if published_at is not None:
                normalized_at = _as_utc(published_at)
                if normalized_at > _utcnow():
                    raise ValueError("published_at must not be in the future")
                row.published_at = normalized_at
            if archived is not None:
                row.archived_at = _utcnow() if archived else None
            row.verified_at = _utcnow()
            session.commit()
            keyword = session.get(Keyword, row.keyword_id)
            draft_count = session.scalar(
                select(func.count(Draft.id)).where(Draft.keyword_id == row.keyword_id)
            ) or 0
            return self._view(row, keyword.text if keyword else "", int(draft_count))
