"""Per-client token-bucket rate limiting for the signaling server.

Buckets refill continuously (``rate`` tokens per ``per`` seconds) and each
allowed action costs one token, so short bursts up to ``rate`` are fine but a
sustained flood is rejected. State is in-memory and per-process — matching the
signaling server's single-process deployment.
"""

from __future__ import annotations

import threading
import time

_CLEANUP_THRESHOLD = 10_000


class RateLimiter:
    """Token bucket per key (typically a client IP)."""

    def __init__(self, rate: int = 30, per: float = 60.0) -> None:
        """Allow up to ``rate`` actions per ``per`` seconds per key."""
        self._rate = float(rate)
        self._per = per
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, last_ts)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        """Consume one token for ``key``; False means the caller is throttled."""
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (self._rate, now))
            tokens = min(self._rate, tokens + (now - last) * (self._rate / self._per))
            allowed = tokens >= 1.0
            self._buckets[key] = (tokens - 1.0 if allowed else tokens, now)
            if len(self._buckets) > _CLEANUP_THRESHOLD:
                # Drop buckets idle long enough to have fully refilled anyway.
                cutoff = now - self._per
                self._buckets = {k: v for k, v in self._buckets.items() if v[1] >= cutoff}
            return allowed
