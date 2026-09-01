from app.logging import redact_secrets


def test_secretish_keys_are_redacted():
    event = {
        "event": "request_sent",
        "client_secret": "abc",
        "api_key": "abc",
        "x_signature": "abc",
        "authorization": "Bearer abc",
        "local_core_token": "abc",
        "password": "abc",
        "keyword": "애드포스트",
        "status": 200,
    }
    out = redact_secrets(None, "info", dict(event))
    assert out["client_secret"] == "[redacted]"
    assert out["api_key"] == "[redacted]"
    assert out["x_signature"] == "[redacted]"
    assert out["authorization"] == "[redacted]"
    assert out["local_core_token"] == "[redacted]"
    assert out["password"] == "[redacted]"
    # non-secret fields survive
    assert out["keyword"] == "애드포스트"
    assert out["status"] == 200
    assert out["event"] == "request_sent"
