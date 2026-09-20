"""The polarization search holds the QBER that free drift walks away.

The fiber's polarization is a random walk, so an uncompensated link degrades
until it crosses the 11% threshold and stops producing key. These drive the
search against the same walk and assert it stays bounded — over a run long
enough for the uncompensated case to fail.
"""

import math
import random

from bench.pol_compensator import CoordinateDescentCompensator

QBER_THRESHOLD = 0.11
#: Error the detector cannot remove (dark counts, imperfect optics). The search
#: only ever sees QBER on top of this, which is why it averages before moving.
BASE_ERROR = 0.01
#: Per-frame polarization step at the shipped defaults: 0.02 rad/s over 250 ms.
DRIFT_PER_FRAME = 0.005
#: Bits disclosed per frame; the QBER the search reads is a binomial estimate.
SAMPLE_BITS = 28


def _run(frames, seed, *, compensate):
    """Walk the fiber for `frames`, returning the true QBER seen each frame."""
    rng = random.Random(seed)
    angle = 0.0
    search = CoordinateDescentCompensator() if compensate else None
    seen = []
    for _ in range(frames):
        angle += DRIFT_PER_FRAME * (rng.random() * 2.0 - 1.0)
        residual = angle - (search.compensation_rad() if search else 0.0)
        qber = min(0.5, math.sin(residual) ** 2 + BASE_ERROR)
        seen.append(qber)
        if search:
            errors = sum(1 for _ in range(SAMPLE_BITS) if rng.random() < qber)
            search.step(errors / SAMPLE_BITS)
    return seen


def test_uncompensated_drift_crosses_the_threshold():
    """The premise: left alone, the walk takes the link out of service."""
    failed = [s for s in range(8) if max(_run(14_400, s, compensate=False)) > QBER_THRESHOLD]
    assert len(failed) >= 4, f"expected most seeds to degrade, only {len(failed)}/8 did"


def test_the_search_holds_the_qber_under_threshold():
    for seed in range(8):
        qbers = _run(14_400, seed, compensate=True)
        worst = max(qbers)
        assert worst < QBER_THRESHOLD, f"seed {seed} reached QBER {worst:.3f}"


def test_the_search_beats_leaving_the_fiber_alone():
    for seed in range(4):
        free = _run(14_400, seed, compensate=False)
        tracked = _run(14_400, seed, compensate=True)
        assert sum(tracked) / len(tracked) < sum(free) / len(free)


def test_a_settled_search_keeps_probing():
    """The dither never stops, so the applied angle always carries a probe —
    that residual ripple is what the QBER chart shows."""
    search = CoordinateDescentCompensator()
    applied = set()
    for _ in range(32):
        applied.add(round(search.compensation_rad(), 6))
        search.step(BASE_ERROR)
    assert len(applied) > 1


def test_compensation_tracks_the_direction_of_a_steady_offset():
    """Against a fixed misalignment the committed angle moves toward it."""
    search = CoordinateDescentCompensator()
    offset = 0.6
    for _ in range(600):
        residual = offset - search.compensation_rad()
        search.step(min(0.5, math.sin(residual) ** 2 + BASE_ERROR))
    assert search.compensation_rad() > 0.3, search.compensation_rad()
