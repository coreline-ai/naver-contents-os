"""Call gateway shared by all external providers.

Responsibilities (docs/12): request-hash TTL cache, in-process dedup, self-imposed
monthly quota guard, 429 exponential backoff with jitter, auth errors never retried,
per-provider concurrency limits, usage counting with a warn threshold.

Storage is injected via small protocols so the providers package never imports app code.
"""

from __future__ import annotations

import hashlib
import json
import random
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Protocol

import httpx
import structlog

log = structlog.get_logger("gateway")


class CacheStore(Protocol):
    def get(self, key: str) -> "CacheEntry | None": ...
    def put(
        self, key: str, provider: str, body: str, ttl_seconds: int, collected_at: datetime
    ) -> None: ...


class UsageStore(Protocol):
    def increment(self, provider: str, period: str) -> int: ...
    def current(self, provider: str, period: str) -> int: ...


class GatewayError(Exception):
    """Raised as one of the app error types via the error_factory hooks below."""


@dataclass(frozen=True)
class CacheEntry:
    body: str
    collected_at: datetime


@dataclass(frozen=True)
class GatewayResult:
    body: str
    from_cache: bool
    collected_at: datetime


@dataclass
class _LockEntry:
    lock: threading.Lock = field(default_factory=threading.Lock)
    users: int = 0


@dataclass
class ProviderPolicy:
    name: str
    monthly_limit: int
    max_concurrency: int = 4
    max_retries_429: int = 3
    backoff_base_seconds: float = 0.5


def cache_key(provider: str, method: str, url: str, params: dict | None, body: dict | None) -> str:
    payload = json.dumps(
        {"p": provider, "m": method.upper(), "u": url, "q": params or {}, "b": body or {}},
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class Gateway:
    cache: CacheStore
    usage: UsageStore
    # error classes injected so this package stays independent of app.errors
    auth_error: type[Exception]
    request_error: type[Exception]
    rate_limit_error: type[Exception]
    quota_error: type[Exception]
    transport_error: type[Exception] | None = None
    schema_error: type[Exception] | None = None
    warn_ratio: float = 0.8
    sleeper: Callable[[float], None] = time.sleep
    rng: Callable[[], float] = random.random
    _locks: dict[str, _LockEntry] = field(default_factory=dict)
    _semaphores: dict[str, threading.Semaphore] = field(default_factory=dict)
    _guard: threading.Lock = field(default_factory=threading.Lock)

    def _acquire_dedup(self, key: str) -> _LockEntry:
        with self._guard:
            entry = self._locks.setdefault(key, _LockEntry())
            entry.users += 1
        entry.lock.acquire()
        return entry

    def _release_dedup(self, key: str, entry: _LockEntry) -> None:
        entry.lock.release()
        with self._guard:
            entry.users -= 1
            if entry.users == 0 and self._locks.get(key) is entry:
                self._locks.pop(key, None)

    def _semaphore(self, policy: ProviderPolicy) -> threading.Semaphore:
        with self._guard:
            if policy.name not in self._semaphores:
                self._semaphores[policy.name] = threading.Semaphore(policy.max_concurrency)
            return self._semaphores[policy.name]

    def request(
        self,
        *,
        policy: ProviderPolicy,
        key: str,
        ttl_seconds: int,
        send: Callable[[], httpx.Response],
        force_refresh: bool = False,
    ) -> GatewayResult:
        """Return body plus provenance. `send` performs the actual HTTP call."""
        lock_entry = self._acquire_dedup(key)
        try:
            if not force_refresh:
                cached = self.cache.get(key)
                if cached is not None:
                    return GatewayResult(cached.body, True, cached.collected_at)

            period = datetime.now(timezone.utc).strftime("%Y%m")
            used = self.usage.current(policy.name, period)
            if used >= policy.monthly_limit:
                raise self.quota_error(
                    f"self-imposed monthly limit reached ({used}/{policy.monthly_limit})",
                    provider=policy.name,
                )
            if used >= policy.monthly_limit * self.warn_ratio:
                log.warning("usage_near_limit", provider=policy.name, used=used, limit=policy.monthly_limit)

            response = self._send_with_backoff(policy, send)
            self.usage.increment(policy.name, period)
            body = response.text
            collected_at = datetime.now(timezone.utc)
            self.cache.put(key, policy.name, body, ttl_seconds, collected_at)
            return GatewayResult(body, False, collected_at)
        finally:
            self._release_dedup(key, lock_entry)

    def _send_with_backoff(self, policy: ProviderPolicy, send: Callable[[], httpx.Response]) -> httpx.Response:
        semaphore = self._semaphore(policy)
        attempt = 0
        while True:
            with semaphore:
                try:
                    response = send()
                except httpx.RequestError as exc:
                    error_type = self.transport_error or self.request_error
                    raise error_type(
                        f"upstream transport failure ({type(exc).__name__})", provider=policy.name
                    ) from exc
            if response.status_code == 200:
                return response
            if response.status_code in (401, 403):
                raise self.auth_error(
                    f"upstream rejected credentials (HTTP {response.status_code})", provider=policy.name
                )
            if response.status_code == 429:
                if attempt >= policy.max_retries_429:
                    raise self.rate_limit_error(
                        f"still rate limited after {attempt} retries", provider=policy.name
                    )
                delay = policy.backoff_base_seconds * (2**attempt) + self.rng() * 0.3
                log.info("backoff_429", provider=policy.name, attempt=attempt, delay=round(delay, 2))
                self.sleeper(delay)
                attempt += 1
                continue
            raise self.request_error(
                f"upstream error HTTP {response.status_code}", provider=policy.name
            )

    def invalid_schema(self, policy: ProviderPolicy, message: str) -> Exception:
        error_type = self.schema_error or self.request_error
        return error_type(message, provider=policy.name)
