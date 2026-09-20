"""Emulated detector bank + timetagger — a TimeTaggerDriver.

Converts fiber frames (photon-bearing pulses from the source) into detection
clicks in the detector's own clock, applying loss, passive basis choice,
efficiency, jitter, dead time, dark counts, and the fiber's residual
polarization error. The real driver wraps a vendor timetagger SDK and its
`clicks()` streaming API is the acquisition interface; the emulator's batch
`detect()` is the equivalent for one fiber frame.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from bench import physics
from bench.clock import ClockModel, sample_clock
from bench.drivers import Click, TimeTaggerDriver
from bench.pol_compensator import CoordinateDescentCompensator, EmulatedPolarization

if TYPE_CHECKING:
    from bench.config import BenchConfig
    from bench.fiber_wire import FiberFrame


class EmulatedTimeTagger(TimeTaggerDriver):
    """Detector driver backed by the physics model."""

    def __init__(self, cfg: BenchConfig) -> None:
        """Build the emulated detector and draw its ground-truth clock."""
        self._cfg = cfg
        # shared-clock mode ⇒ the source clock rides a side-channel, so the
        # detector effectively knows it (zero offset/drift to recover);
        # qubit mode ⇒ recover it from the sync string.
        self._clock: ClockModel = (
            ClockModel(0, 0.0, 0.0) if cfg.sync.mode == "shared-clock" else sample_clock(cfg)
        )
        self._pol = EmulatedPolarization(cfg)
        self._compensator = CoordinateDescentCompensator()
        self._running = False

    async def start(self) -> None:
        """Begin acquisition."""
        self._running = True

    async def stop(self) -> None:
        """End acquisition."""
        self._running = False

    @property
    def clock(self) -> ClockModel:
        """The (test-visible) ground-truth clock the recovery must invert."""
        return self._clock

    @property
    def compensator(self) -> CoordinateDescentCompensator:
        """The polarization search tracking this bench's fiber."""
        return self._compensator

    def report_qber(self, observed_qber: float) -> None:
        """Feed the search one frame's measured QBER, from the browser."""
        self._compensator.step(observed_qber)

    def detect(self, frame: FiberFrame) -> list[Click]:
        """Detect one fiber frame's pulses; advance the fiber polarization."""
        if not self._running:
            msg = "detect() before start()"
            raise RuntimeError(msg)
        self._pol.step()
        # What the detector sees is the fiber's rotation less what the
        # compensator currently applies.
        residual = self._pol.angle_rad - self._compensator.compensation_rad()
        return physics.detect(frame.pulses, self._cfg, self._clock, residual)
