"""Uniform JSON error envelope for the qvc signaling API.

Implements the cross-repo backend contract (see the website repo at
``docs/api-contract/schemas/error.schema.json``): every 4xx/5xx response body
is::

    {"error": {"code": "<slug>", "message": "<human>", "details": <optional>}}

The HTTP status carries the class; the envelope never restates it.
"""

from __future__ import annotations

import logging

from flask import jsonify
from werkzeug.exceptions import HTTPException

_log = logging.getLogger(__name__)

# Stable machine codes for framework-raised HTTP errors. Only the statuses this
# server can actually reach: routing produces 404 and 405, an unhandled view
# raises 500, and werkzeug can raise 400 on a malformed request. There is no
# auth challenge, conflict, body parsing or content negotiation here, and rate
# limiting rejects at Socket.IO connect rather than as HTTP. Anything else falls
# through to the "http_error" default below.
_STATUS_CODES = {
    400: "bad_request",
    404: "not_found",
    405: "method_not_allowed",
    500: "internal_error",
}


def respond_error(code: str, message: str, status: int, details=None):
    """Return a Flask ``(response, status)`` tuple carrying the error envelope."""
    body: dict = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    return jsonify({"error": body}), status


def register_error_handlers(app):
    """Make framework-raised errors (404/405/500, ...) use the envelope too."""

    @app.errorhandler(HTTPException)
    def _http_exception(exc: HTTPException):
        code = _STATUS_CODES.get(exc.code, "http_error")
        return respond_error(code, exc.description or exc.name, exc.code or 500)

    @app.errorhandler(Exception)
    def _unhandled(exc: Exception):
        _log.exception("Unhandled error: %s", exc)
        return respond_error("internal_error", "Internal server error.", 500)

    return app
