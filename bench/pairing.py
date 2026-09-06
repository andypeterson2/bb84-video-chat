"""Browser↔daemon pairing.

The WebSocket hands out raw detection data (and, on the source side, controls
the emulated attack), so it is a real trust boundary: any local process or
web page could otherwise connect. A one-time token, printed to the daemon's
stdout at startup, must be presented on the first message; the user pastes it
into the browser once. Only one pairing is active at a time.
"""

from __future__ import annotations

import hmac
import secrets


class Pairing:
    """Single-pairing token gate with constant-time verification."""

    def __init__(self, token: str | None = None) -> None:
        """Mint (or accept) the one-time pairing token."""
        self._token = token or secrets.token_urlsafe(24)
        self._paired = False

    @property
    def token(self) -> str:
        """The one-time pairing token to present to the browser."""
        return self._token

    def verify(self, presented: str) -> bool:
        """Constant-time token check; marks the pairing active on success."""
        if not isinstance(presented, str):
            return False
        ok = hmac.compare_digest(presented, self._token)
        if ok:
            # A fresh valid pairing evicts any previous one (tab reload).
            self._paired = True
        return ok

    @property
    def is_paired(self) -> bool:
        """Whether a valid token has been presented."""
        return self._paired

    def reset(self) -> None:
        """Drop the active pairing (connection closed)."""
        self._paired = False
