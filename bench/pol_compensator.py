"""Emulated polarization drift and its compensation.

On a deployed fiber, polarization rotates slowly and is the dominant QBER
dynamic (per the DTU field trial); motorized controllers chase it with a
coordinate-descent search. This models both the drift and that search, so an
uncompensated link visibly degrades and a compensated one holds.

The search only ever sees QBER estimated from a few dozen disclosed bits, on
top of an error floor it cannot remove. A step proportional to that estimate
never settles — it keeps moving at the floor and amplifies the sampling noise.
So the search dithers instead: it probes one side for a block of frames, the
other side for the next, and commits toward whichever block measured lower.
Averaging over a block is what makes the comparison survive the noise.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from bench import rng
from bench.drivers import PolarizationCompensatorDriver

if TYPE_CHECKING:
    from bench.config import BenchConfig


class EmulatedPolarization:
    """The fiber's true polarization angle, advanced per frame by a walk."""

    def __init__(self, cfg: BenchConfig) -> None:
        """Seed the fiber's polarization walk from the config."""
        self._rng = rng.stream(cfg.seed, rng.STAGE_CHANNEL + 100)
        self._rad = 0.0
        self._drift_per_frame = cfg.fiber.pol_drift_rad_per_s * (
            cfg.timing.frame_period_ms / 1000.0 if cfg.timing.frame_period_ms else 0.001
        )

    @property
    def angle_rad(self) -> float:
        """The fiber's current true polarization angle (rad)."""
        return self._rad

    def step(self) -> None:
        """Advance the true polarization one frame (signed random walk)."""
        self._rad += self._drift_per_frame * (self._rng.random() * 2.0 - 1.0)


class CoordinateDescentCompensator(PolarizationCompensatorDriver):
    """Dithered coordinate descent on the single polarization axis.

    Holds a committed compensation angle and probes one dither step either side
    of it, alternating each block. When a block's mean QBER beats the previous
    block's, the committed angle moves that way. The probe never stops, so the
    applied angle always carries the dither — that residual ripple is the
    drift-and-recover the QBER chart shows.
    """

    def __init__(self, *, dither_rad: float = 0.08, block_frames: int = 8, gain: float = 0.5) -> None:
        """Configure the probe amplitude, averaging block, and commit step."""
        self._comp = 0.0
        self._dither = dither_rad
        self._block = max(1, block_frames)
        self._gain = gain
        self._direction = 1.0
        self._samples: list[float] = []
        self._previous_mean: float | None = None

    def compensation_rad(self) -> float:
        """Angle currently applied, committed value plus the active probe."""
        return self._comp + self._direction * self._dither

    def step(self, observed_qber: float) -> None:
        """Feed one frame's QBER; commit and flip at each block boundary."""
        self._samples.append(observed_qber)
        if len(self._samples) < self._block:
            return
        mean = sum(self._samples) / len(self._samples)
        self._samples = []
        if self._previous_mean is not None:
            # The previous block probed the other side, so a lower mean here
            # means this side is better; a higher one means the other side was.
            toward = 1.0 if mean < self._previous_mean else -1.0
            self._comp += toward * self._direction * self._dither * self._gain
        self._previous_mean = mean
        self._direction = -self._direction
