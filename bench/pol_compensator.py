"""Emulated polarization drift and its compensation.

On a deployed fiber, polarization rotates slowly and is the dominant QBER
dynamic (per the DTU field trial); motorized controllers chase it with a
coordinate-descent search, discarding the high-QBER chunks during overshoot.
This models both the drift and a compensator that periodically re-zeroes it
with a configurable overshoot transient, so the QBER strip chart shows the
same drift-and-recover a real bench does.
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
    """Re-zeroing compensator with a modeled overshoot transient.

    Given the residual polarization error it observes (via QBER), it nudges
    its compensation toward cancelling it — occasionally overshooting, which
    briefly RAISES QBER before settling, exactly the transient a real search
    produces.
    """

    def __init__(self, *, gain: float = 0.6, overshoot: float = 1.4) -> None:
        """Configure the compensator's search gain and overshoot."""
        self._comp = 0.0
        self._gain = gain
        self._overshoot = overshoot
        self._last_qber = 0.0

    def compensation_rad(self) -> float:
        """Current compensation angle (rad)."""
        return self._comp

    def step(self, observed_qber: float) -> None:
        """Advance the search one step from the latest observed QBER."""
        # Move against the observed error; overshoot when QBER jumped up.
        rising = observed_qber > self._last_qber
        factor = self._overshoot if rising else self._gain
        # QBER ~ sin^2(residual); approximate residual magnitude from it.
        residual = observed_qber**0.5
        self._comp -= factor * residual * (1.0 if self._comp >= 0 else -1.0)
        self._last_qber = observed_qber
