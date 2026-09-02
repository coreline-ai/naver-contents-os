from datetime import datetime, timezone

import httpx
import pytest

from app import errors
from app.db import make_engine, make_session_factory
from app.models_db import Base
from app.stores import SqlUsageStore
from providers.gateway import ProviderPolicy, cache_key, retry_after_seconds
from tests.conftest import FakeUsage, make_gateway


def make_sender(responses: list[httpx.Response]):
    calls = {"count": 0}

    def send() -> httpx.Response:
        response = responses[min(calls["count"], len(responses) - 1)]
        calls["count"] += 1
        return response

    return send, calls


def test_cache_hit_skips_second_send(policy):
    gateway = make_gateway()
    send, calls = make_sender([httpx.Response(200, text='{"a":1}')])

    first = gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    second = gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)

    assert (first.body, first.from_cache) == ('{"a":1}', False)
    assert (second.body, second.from_cache) == ('{"a":1}', True)
    assert second.collected_at == first.collected_at
    assert calls["count"] == 1


def test_force_refresh_bypasses_cache(policy):
    gateway = make_gateway()
    send, calls = make_sender([httpx.Response(200, text="x")])
    gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    gateway.request(policy=policy, key="k", ttl_seconds=60, send=send, force_refresh=True)
    assert calls["count"] == 2


def test_429_backs_off_then_succeeds(policy):
    gateway = make_gateway()
    send, calls = make_sender(
        [httpx.Response(429), httpx.Response(429), httpx.Response(200, text="ok")]
    )
    result = gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    assert result.body == "ok"
    assert calls["count"] == 3
    assert len(gateway.recorded_sleeps) == 2
    assert gateway.recorded_sleeps[1] > gateway.recorded_sleeps[0]  # exponential


def test_429_respects_numeric_retry_after(policy):
    gateway = make_gateway()
    send, _ = make_sender(
        [httpx.Response(429, headers={"Retry-After": "3"}), httpx.Response(200, text="ok")]
    )
    gateway.request(policy=policy, key="retry-after", ttl_seconds=60, send=send)
    assert gateway.recorded_sleeps[0] == 3


def test_retry_after_accepts_http_date():
    now = datetime(2026, 9, 2, 0, 0, 0, tzinfo=timezone.utc)
    assert retry_after_seconds("Wed, 02 Sep 2026 00:00:05 GMT", now) == 5
    assert retry_after_seconds("invalid", now) is None


def test_persistent_429_raises_rate_limit(policy):
    gateway = make_gateway()
    send, calls = make_sender([httpx.Response(429)])
    with pytest.raises(errors.RateLimitError):
        gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    assert calls["count"] == policy.max_retries_429 + 1


def test_each_429_retry_reserves_an_attempt(policy):
    usage = FakeUsage()
    gateway = make_gateway(usage=usage)
    send, _ = make_sender(
        [httpx.Response(429), httpx.Response(429), httpx.Response(200, text="ok")]
    )
    gateway.request(policy=policy, key="counted-retries", ttl_seconds=60, send=send)
    assert usage.total(policy.name) == 3


@pytest.mark.parametrize("status", [401, 403])
def test_auth_errors_never_retry(policy, status):
    gateway = make_gateway()
    send, calls = make_sender([httpx.Response(status)])
    with pytest.raises(errors.AuthError):
        gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    assert calls["count"] == 1
    assert gateway.recorded_sleeps == []


def test_quota_guard_blocks_before_sending():
    usage = FakeUsage()
    policy = ProviderPolicy(name="p", monthly_limit=2)
    gateway = make_gateway(usage=usage)
    send, calls = make_sender([httpx.Response(200, text="x")])

    gateway.request(policy=policy, key="k1", ttl_seconds=60, send=send)
    gateway.request(policy=policy, key="k2", ttl_seconds=60, send=send)
    with pytest.raises(errors.QuotaError):
        gateway.request(policy=policy, key="k3", ttl_seconds=60, send=send)
    assert calls["count"] == 2
    assert usage.total("p") == 2


def test_cache_hit_does_not_count_usage(policy):
    usage = FakeUsage()
    gateway = make_gateway(usage=usage)
    send, _ = make_sender([httpx.Response(200, text="x")])
    gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    assert usage.total(policy.name) == 1


def test_daily_quota_blocks_without_consuming_monthly_reservation():
    usage = FakeUsage()
    policy = ProviderPolicy(name="p", monthly_limit=10, daily_limit=2)
    gateway = make_gateway(usage=usage)
    send, calls = make_sender([httpx.Response(200, text="x")])

    gateway.request(policy=policy, key="d1", ttl_seconds=60, send=send)
    gateway.request(policy=policy, key="d2", ttl_seconds=60, send=send)
    with pytest.raises(errors.QuotaError, match="daily"):
        gateway.request(policy=policy, key="d3", ttl_seconds=60, send=send)

    assert calls["count"] == 2
    assert usage.current("p", datetime.now(timezone.utc).strftime("%Y%m")) == 2


def test_rps_policy_paces_distinct_requests():
    gateway = make_gateway()
    policy = ProviderPolicy(name="paced", monthly_limit=10, requests_per_second=2)
    send, _ = make_sender([httpx.Response(200, text="x")])
    gateway.request(policy=policy, key="r1", ttl_seconds=60, send=send)
    gateway.request(policy=policy, key="r2", ttl_seconds=60, send=send)
    assert gateway.recorded_sleeps
    assert gateway.recorded_sleeps[-1] > 0.45


def test_failed_transport_attempt_consumes_quota():
    usage = FakeUsage()
    gateway = make_gateway(usage=usage)
    policy = ProviderPolicy(name="attempts", monthly_limit=10)
    request = httpx.Request("GET", "https://example.invalid")

    with pytest.raises(errors.UpstreamUnavailableError):
        gateway.request(
            policy=policy,
            key="failed-attempt",
            ttl_seconds=60,
            send=lambda: (_ for _ in ()).throw(httpx.ConnectTimeout("timeout", request=request)),
        )
    assert usage.total("attempts") == 1


def test_4xx_attempt_consumes_quota():
    usage = FakeUsage()
    gateway = make_gateway(usage=usage)
    policy = ProviderPolicy(name="bad-request", monthly_limit=10)
    with pytest.raises(errors.RequestError):
        gateway.request(
            policy=policy,
            key="bad-request",
            ttl_seconds=60,
            send=lambda: httpx.Response(400),
        )
    assert usage.total("bad-request") == 1


def test_sql_usage_reservation_is_atomic_across_month_and_day(tmp_path):
    engine = make_engine(tmp_path / "usage.db")
    Base.metadata.create_all(engine)
    store = SqlUsageStore(make_session_factory(engine))
    periods = {"202609": 1, "20260902": 1}

    assert store.reserve("provider", periods) == {"202609": 1, "20260902": 1}
    assert store.reserve("provider", periods) is None
    assert store.current("provider", "202609") == 1
    assert store.current("provider", "20260902") == 1


def test_cache_key_is_deterministic_and_distinct():
    a = cache_key("p", "GET", "/x", {"q": "테스트", "n": 1}, None)
    b = cache_key("p", "GET", "/x", {"n": 1, "q": "테스트"}, None)
    c = cache_key("p", "GET", "/x", {"q": "다른", "n": 1}, None)
    assert a == b
    assert a != c


def test_transport_error_is_mapped_and_lock_is_released(policy):
    gateway = make_gateway()
    request = httpx.Request("GET", "https://example.invalid")

    def send():
        raise httpx.ConnectTimeout("timeout", request=request)

    with pytest.raises(errors.UpstreamUnavailableError):
        gateway.request(policy=policy, key="transport", ttl_seconds=60, send=send)
    assert gateway._locks == {}


def test_unique_request_locks_do_not_accumulate(policy):
    gateway = make_gateway()
    send, _ = make_sender([httpx.Response(200, text="ok")])
    for index in range(100):
        gateway.request(policy=policy, key=f"unique-{index}", ttl_seconds=60, send=send)
    assert gateway._locks == {}
