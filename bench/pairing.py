"""Browser↔daemon pairing.

The WebSocket hands out raw detection data (and, on the source side, controls
the emulated attack), so it is a real trust boundary: any local process or
web page could otherwise connect. A one-time token, printed to the daemon's
stdout at startup, must be presented on the first message; the user pastes it
into the browser once.

`Pairing` is a stateless token holder: it owns the shared secret and verifies
presented tokens, but carries no paired/unpaired state. Whether a *connection*
has paired is per-connection state (see `BenchConnection`), so a second
concurrent connection can never inherit the first's paired status from a shared
object — and a connection opening or closing cannot reset another's pairing.
"""

from __future__ import annotations

import hmac
import secrets


class Pairing:
    """One-time pairing secret with constant-time verification (stateless)."""

    def __init__(self, token: str | None = None) -> None:
        """Mint (or accept) the one-time pairing token."""
        self._token = token or secrets.token_urlsafe(24)

    @property
    def token(self) -> str:
        """The one-time pairing token to present to the browser."""
        return self._token

    def verify(self, presented: str) -> bool:
        """Constant-time check that `presented` matches the pairing token."""
        if not isinstance(presented, str):
            return False
        return hmac.compare_digest(presented, self._token)
