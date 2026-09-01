import httpx
import pytest

from app import errors
from providers.gateway import ProviderPolicy, cache_key
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


def test_persistent_429_raises_rate_limit(policy):
    gateway = make_gateway()
    send, calls = make_sender([httpx.Response(429)])
    with pytest.raises(errors.RateLimitError):
        gateway.request(policy=policy, key="k", ttl_seconds=60, send=send)
    assert calls["count"] == policy.max_retries_429 + 1


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
