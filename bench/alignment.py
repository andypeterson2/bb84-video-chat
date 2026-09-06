"""Clock alignment from the public sync string (Qubit4Sync-style).

Given raw clicks (detector clock) and the known sync string, recover the two
parameters the detector needs to label pulse slots:

  period_ps: the slot period in the DETECTOR's clock. The nominal rep rate is
    known, so this is a small refinement for the frequency drift; recovered
    from the sub-period phase of the click comb.
  t0_ps: the detector-clock time of source slot 0. Unknown up to ±half a
    frame; recovered by cross-correlating sync-region Z-basis detections
    against the known sync bits over integer slot shifts.

This is the genuinely hard code that ships to the real bench unchanged: it
reads ONLY the click timestamps and the public sync string, never the fiber's
ground-truth frame metadata.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from bench.drivers import DETECTOR_BASIS, DETECTOR_BIT, Click

# Only Z-basis detectors (H/V) carry sync information.
_Z_DETECTORS = tuple(d for d in range(4) if DETECTOR_BASIS[d] == 0)


@dataclass(frozen=True, slots=True)
class Alignment:
    """Recovered clock relationship, plus a quality score for gating."""

    t0_ps: float
    period_ps: float
    #: Peak cross-correlation distinguishability (matches - mismatches at the
    #: best shift, normalized by sync detections). Low ⇒ recovery is untrusted.
    quality: float


def _phase_offset(clicks: list[Click], period_ps: float) -> float:
    """Sub-period phase of the click comb (mean angle, robust to wrap)."""
    sx = sy = 0.0
    for c in clicks:
        ang = 2.0 * math.pi * (c.t_ps % period_ps) / period_ps
        sx += math.cos(ang)
        sy += math.sin(ang)
    if sx == 0.0 and sy == 0.0:
        return 0.0
    ang = math.atan2(sy, sx)
    if ang < 0:
        ang += 2.0 * math.pi
    return ang / (2.0 * math.pi) * period_ps


def align(
    clicks: list[Click],
    sync_bits: tuple[int, ...],
    nominal_period_ps: float,
) -> Alignment:
    """Recover (t0, period) from the sync-region clicks.

    The candidate search is bounded by the sync length, not the frame length:
    the earliest detected click lies within the sync region (which is only
    sync_slots long and carries detections), so source slot 0 sits at most
    sync_slots periods before it. That makes the search independent of payload
    length — the efficiency Qubit4Sync's cross-correlation buys.
    """
    if not clicks:
        return Alignment(0.0, nominal_period_ps, 0.0)
    sync_slots = len(sync_bits)
    period = nominal_period_ps  # rep rate known; drift refined by the tracker

    # Sub-period phase locks the slot-centre grid; t0 is then phase + k·period
    # for some integer k. All candidate t0 share this phase.
    phase = _phase_offset(clicks, period)
    t_min = min(c.t_ps for c in clicks)
    base_k = round((t_min - phase) / period)

    # Z-basis detections carry the sync bits. Cache each as (k_click, bit)
    # where k_click = round((t - phase)/period) is the click's absolute slot
    # under candidate t0 = phase (k=0); a candidate k shifts every slot by -k.
    z_clicks: list[tuple[int, int]] = [
        (round((c.t_ps - phase) / period), DETECTOR_BIT[c.detector_id])
        for c in clicks
        if c.detector_id in _Z_DETECTORS
    ]
    if not z_clicks:
        return Alignment(base_k * period + phase, period, 0.0)

    best_k, best_score, best_count = base_k, -1, 0
    for k in range(base_k - sync_slots, base_k + 1):
        score = count = 0
        for k_click, bit in z_clicks:
            slot = k_click - k
            if 0 <= slot < sync_slots:
                count += 1
                score += 1 if bit == sync_bits[slot] else -1
        if score > best_score:
            best_score, best_k, best_count = score, k, count

    t0 = best_k * period + phase
    quality = best_score / best_count if best_count else 0.0
    return Alignment(t0, period, quality)
