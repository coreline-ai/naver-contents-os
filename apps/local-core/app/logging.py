"""structlog setup. Redacts secret-ish keys so a mistake upstream cannot leak values."""

from __future__ import annotations

import logging
from typing import Any

import structlog

REDACT_MARKERS = ("secret", "token", "key", "signature", "authorization", "password", "cookie")


def redact_secrets(_logger: Any, _method: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    for name in list(event_dict):
        lowered = name.lower()
        if lowered == "event":
            continue
        if any(marker in lowered for marker in REDACT_MARKERS):
            event_dict[name] = "[redacted]"
    return event_dict


def configure_logging(level: int = logging.INFO) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            redact_secrets,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.KeyValueRenderer(key_order=["timestamp", "level", "event"]),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
