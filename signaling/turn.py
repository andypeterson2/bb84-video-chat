"""Short-lived TURN credentials (coturn REST API / use-auth-secret).

The signaling server mints ephemeral TURN credentials so no long-lived secret
ever reaches the browser. coturn is configured with `use-auth-secret` and the
same `static-auth-secret`; it recomputes the HMAC to validate the credential and
honours the expiry embedded in the username. Scheme:
draft-uberti-behave-turn-rest-00 (username = "<expiry_unix>:<nonce>",
credential = base64(HMAC-SHA1(secret, username))).

Media stays end-to-end encrypted regardless: a TURN relay only ever forwards
the DTLS-SRTP ciphertext, and the browser's per-frame E2EE sits above that.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time

_DEFAULT_STUN = (
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
)
_DEFAULT_TTL = 3600
_MIN_TTL = 60


def _split_env_list(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def _stun_servers() -> list[dict]:
    """STUN entries: QVC_STUN_URLS if set, else the built-in defaults."""
    urls = _split_env_list("QVC_STUN_URLS") or list(_DEFAULT_STUN)
    return [{"urls": urls}] if urls else []


def _ttl() -> int:
    try:
        return max(_MIN_TTL, int(os.environ.get("QVC_TURN_TTL", str(_DEFAULT_TTL))))
    except ValueError:
        return _DEFAULT_TTL


def turn_credential(secret: str, urls: list[str], ttl: int, now: float | None = None) -> dict:
    """Mint one ephemeral TURN credential valid for `ttl` seconds.

    The username carries the absolute expiry so coturn can reject stale
    credentials without shared state; the credential is the HMAC coturn
    recomputes. The shared secret never leaves the server.
    """
    expiry = int((time.time() if now is None else now) + ttl)
    username = f"{expiry}:{secrets.token_hex(8)}"
    mac = hmac.new(secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1)
    return {
        "urls": list(urls),
        "username": username,
        "credential": base64.b64encode(mac.digest()).decode("ascii"),
    }


def ice_servers(now: float | None = None) -> list[dict]:
    """ICE server list for a browser: STUN always, TURN when configured.

    TURN is appended only when both QVC_TURN_SECRET and QVC_TURN_URLS are set;
    otherwise the caller gets STUN-only (graceful — no error, calls that don't
    need a relay still work). The shared secret is never placed in the result.
    """
    servers = _stun_servers()
    secret = os.environ.get("QVC_TURN_SECRET", "")
    urls = _split_env_list("QVC_TURN_URLS")
    if secret and urls:
        servers.append(turn_credential(secret, urls, _ttl(), now=now))
    return servers
