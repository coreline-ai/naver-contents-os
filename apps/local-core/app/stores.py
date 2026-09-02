"""SQLAlchemy-backed implementations of the gateway storage protocols."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session, sessionmaker

from app.models_db import ApiCache, ApiUsage
from providers.gateway import CacheEntry


class SqlCacheStore:
    def __init__(self, session_factory: sessionmaker[Session]):
        self._sessions = session_factory

    def get(self, key: str) -> CacheEntry | None:
        now = datetime.now(timezone.utc)
        with self._sessions() as session:
            row = session.get(ApiCache, key)
            if row is None:
                return None
            expires = row.expires_at
            if expires.tzinfo is None:  # SQLite drops tzinfo on round-trip
                expires = expires.replace(tzinfo=timezone.utc)
            if expires <= now:
                session.delete(row)
                session.commit()
                return None
            collected_at = row.created_at
            if collected_at.tzinfo is None:
                collected_at = collected_at.replace(tzinfo=timezone.utc)
            return CacheEntry(body=row.body, collected_at=collected_at)

    def put(
        self,
        key: str,
        provider: str,
        body: str,
        ttl_seconds: int,
        collected_at: datetime,
    ) -> None:
        now = collected_at
        with self._sessions() as session:
            statement = (
                sqlite_insert(ApiCache)
                .values(
                    key=key,
                    provider=provider,
                    body=body,
                    created_at=now,
                    expires_at=now + timedelta(seconds=ttl_seconds),
                )
                .on_conflict_do_update(
                    index_elements=[ApiCache.key],
                    set_={"body": body, "created_at": now, "expires_at": now + timedelta(seconds=ttl_seconds)},
                )
            )
            session.execute(statement)
            session.commit()


class SqlUsageStore:
    def __init__(self, session_factory: sessionmaker[Session]):
        self._sessions = session_factory

    def reserve(self, provider: str, limits: dict[str, int]) -> dict[str, int] | None:
        """Atomically reserve one call in every period or leave all counts unchanged."""
        with self._sessions() as session:
            for period in limits:
                session.execute(
                    sqlite_insert(ApiUsage)
                    .values(provider=provider, period=period, count=0)
                    .on_conflict_do_nothing(
                        index_elements=[ApiUsage.provider, ApiUsage.period]
                    )
                )

            for period, limit in limits.items():
                result = session.execute(
                    update(ApiUsage)
                    .where(
                        ApiUsage.provider == provider,
                        ApiUsage.period == period,
                        ApiUsage.count < limit,
                    )
                    .values(count=ApiUsage.count + 1)
                )
                if result.rowcount != 1:
                    session.rollback()
                    return None

            rows = session.scalars(
                select(ApiUsage).where(
                    ApiUsage.provider == provider,
                    ApiUsage.period.in_(limits),
                )
            ).all()
            reserved = {row.period: row.count for row in rows}
            session.commit()
            return reserved

    def current(self, provider: str, period: str) -> int:
        with self._sessions() as session:
            row = session.scalar(
                select(ApiUsage).where(ApiUsage.provider == provider, ApiUsage.period == period)
            )
            return row.count if row else 0
