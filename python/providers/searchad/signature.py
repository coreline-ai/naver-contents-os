"""SearchAd HMAC-SHA256 request signing.

Rules that are easy to get wrong (docs/12, official signaturehelper.py):
- message is "<timestamp>.<METHOD>.<uri>" with the bare path, never the query string
- the secret is used as raw UTF-8 bytes, never Base64-decoded
- timestamp is a millisecond epoch string
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time


def build_signature(timestamp: str, method: str, uri: str, secret_key: str) -> str:
    if "?" in uri:
        raise ValueError("sign the bare path: query strings must not be part of the signature message")
    message = f"{timestamp}.{method.upper()}.{uri}"
    digest = hmac.new(secret_key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii")


def auth_headers(
    method: str,
    uri: str,
    api_key: str,
    secret_key: str,
    customer_id: str,
    timestamp: str | None = None,
) -> dict[str, str]:
    ts = timestamp or str(round(time.time() * 1000))
    return {
        "X-Timestamp": ts,
        "X-API-KEY": api_key,
        "X-Customer": str(customer_id),
        "X-Signature": build_signature(ts, method, uri, secret_key),
    }
