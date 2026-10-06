/**
 * Per-client token-bucket rate limiting.
 *
 * Buckets refill continuously (`rate` tokens per `per` seconds) and each
 * allowed action costs one, so short bursts up to `rate` pass and a sustained
 * flood is rejected. State is in-memory and per-process, matching how this
 * server deploys.
 */

/**
 * A ceiling on tracked buckets, so a client that can vary its key — a spoofed
 * X-Forwarded-For, say — cannot grow memory without bound.
 */
const MAX_BUCKETS = 10_000;

export class RateLimiter {
  /** Allow up to `rate` actions per `per` seconds for each key. */
  constructor(rate = 30, per = 60) {
    this._rate = Number(rate);
    this._per = Number(per);
    this._buckets = new Map();
    this._nextSweep = Date.now() / 1000 + this._per;
  }

  /** Spend one token for `key`. False means the caller is throttled. */
  allow(key) {
    const now = Date.now() / 1000;
    const [tokens, last] = this._buckets.get(key) ?? [this._rate, now];
    const refilled = Math.min(this._rate, tokens + (now - last) * (this._rate / this._per));
    const allowed = refilled >= 1;
    this._buckets.set(key, [allowed ? refilled - 1 : refilled, now]);

    if (now >= this._nextSweep) {
      // Time-triggered rather than size-triggered, so idle buckets are dropped
      // even on a small table and memory tracks live clients.
      this._nextSweep = now + this._per;
      const cutoff = now - this._per;
      for (const [k, [, ts]] of this._buckets) {
        if (ts < cutoff) this._buckets.delete(k);
      }
    }
    if (this._buckets.size > MAX_BUCKETS) {
      // Still over after sweeping: evict the oldest-touched first.
      const excess = [...this._buckets.entries()]
        .sort((a, b) => a[1][1] - b[1][1])
        .slice(0, this._buckets.size - MAX_BUCKETS);
      for (const [k] of excess) this._buckets.delete(k);
    }
    return allowed;
  }
}
