"""Standard error codes for the local API. External failures are always mapped
to one of these before they reach a response or a log line (docs/12)."""

from __future__ import annotations


class CoreError(Exception):
    code = "upstream"
    http_status = 502

    def __init__(self, message: str, *, provider: str = "", detail: str = ""):
        super().__init__(message)
        self.message = message
        self.provider = provider
        self.detail = detail

    def payload(self) -> dict:
        body = {"code": self.code, "message": self.message}
        if self.provider:
            body["provider"] = self.provider
        if self.detail:
            body["detail"] = self.detail
        return body


class AuthError(CoreError):
    """Upstream 401/403. Never auto-retried."""

    code = "auth"
    http_status = 502


class RequestError(CoreError):
    """Bad parameters / upstream 4xx that is not auth or rate limiting."""

    code = "request"
    http_status = 502


class SchemaError(CoreError):
    """Upstream 200 but the body does not match the expected shape."""

    code = "schema"
    http_status = 502


class RateLimitError(CoreError):
    """Upstream 429 persisted through backoff."""

    code = "rate_limit"
    http_status = 503


class QuotaError(CoreError):
    """Self-imposed monthly limit reached; the call was never sent."""

    code = "quota"
    http_status = 429


class UnconfiguredError(CoreError):
    """Provider credentials missing in .env; treated as missing data, not a crash."""

    code = "unconfigured"
    http_status = 424
