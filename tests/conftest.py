from __future__ import annotations

from datetime import datetime

import pytest

from app import errors
from providers.gateway import CacheEntry, Gateway, ProviderPolicy


class FakeCache:
    def __init__(self):
        self.data: dict[str, CacheEntry] = {}

    def get(self, key: str) -> CacheEntry | None:
        return self.data.get(key)

    def put(
        self, key: str, provider: str, body: str, ttl_seconds: int, collected_at: datetime
    ) -> None:
        self.data[key] = CacheEntry(body, collected_at)


class FakeUsage:
    def __init__(self):
        self.counts: dict[tuple[str, str], int] = {}

    def increment(self, provider: str, period: str) -> int:
        self.counts[(provider, period)] = self.counts.get((provider, period), 0) + 1
        return self.counts[(provider, period)]

    def current(self, provider: str, period: str) -> int:
        return self.counts.get((provider, period), 0)

    def total(self, provider: str) -> int:
        return sum(v for (p, _), v in self.counts.items() if p == provider)


def make_gateway(cache=None, usage=None, sleeper=None, **kwargs) -> Gateway:
    sleeps: list[float] = []
    gateway = Gateway(
        cache=cache if cache is not None else FakeCache(),
        usage=usage if usage is not None else FakeUsage(),
        auth_error=errors.AuthError,
        request_error=errors.RequestError,
        rate_limit_error=errors.RateLimitError,
        quota_error=errors.QuotaError,
        transport_error=errors.UpstreamUnavailableError,
        schema_error=errors.SchemaError,
        sleeper=sleeper if sleeper is not None else sleeps.append,
        rng=lambda: 0.0,
        **kwargs,
    )
    gateway.recorded_sleeps = sleeps  # type: ignore[attr-defined]
    return gateway


@pytest.fixture
def policy() -> ProviderPolicy:
    return ProviderPolicy(name="test_provider", monthly_limit=100)
