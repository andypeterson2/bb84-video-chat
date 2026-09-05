"""Per-client token-bucket rate limiting for the signaling server.

Buckets refill continuously (``rate`` tokens per ``per`` seconds) and each
allowed action costs one token, so short bursts up to ``rate`` are fine but a
sustained flood is rejected. State is in-memory and per-process — matching the
signaling server's single-process deployment.
"""

from __future__ import annotations

import threading
import time

# Hard ceiling on tracked buckets. A client that can vary its key (e.g. XFF
# spoofing when a deployment mistakenly trusts it) must not grow memory without
# bound; beyond the cap the oldest buckets are evicted outright.
_MAX_BUCKETS = 10_000


class RateLimiter:
    """Token bucket per key (typically a client IP)."""

    def __init__(self, rate: int = 30, per: float = 60.0) -> None:
        """Allow up to ``rate`` actions per ``per`` seconds per key."""
        self._rate = float(rate)
        self._per = per
        self._buckets: dict[str, tuple[float, float]] = {}  # key -> (tokens, last_ts)
        self._lock = threading.Lock()
        self._next_sweep = time.monotonic() + per

    def allow(self, key: str) -> bool:
        """Consume one token for ``key``; False means the caller is throttled."""
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (self._rate, now))
            tokens = min(self._rate, tokens + (now - last) * (self._rate / self._per))
            allowed = tokens >= 1.0
            self._buckets[key] = (tokens - 1.0 if allowed else tokens, now)
            if now >= self._next_sweep:
                # Time-triggered (not size-triggered): idle buckets are dropped
                # even when the table is small, so memory tracks live clients.
                self._next_sweep = now + self._per
                cutoff = now - self._per
                self._buckets = {k: v for k, v in self._buckets.items() if v[1] >= cutoff}
            if len(self._buckets) > _MAX_BUCKETS:
                # Still over after sweeping: evict oldest-touched first.
                for stale_key, _ in sorted(self._buckets.items(), key=lambda kv: kv[1][1])[
                    : len(self._buckets) - _MAX_BUCKETS
                ]:
                    del self._buckets[stale_key]
            return allowed
