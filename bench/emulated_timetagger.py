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
from bench.pol_compensator import EmulatedPolarization

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
        self._running = False

    #: shared-clock benches declare a hardware sync input.
    @property
    def has_sync_input(self) -> bool:  # type: ignore[override]
        """Whether this bench has a hardware sync input (shared-clock mode)."""
        return self._cfg.sync.mode == "shared-clock"

    def configure(self, config: object) -> None:
        """No-op: the emulated detector takes its parameters at construction."""

    async def start(self) -> None:
        """Begin acquisition."""
        self._running = True

    async def stop(self) -> None:
        """End acquisition."""
        self._running = False

    async def clicks(self):  # pragma: no cover - real-hardware streaming path
        """Streaming click interface (real-hardware contract).

        The emulator drives detection per fiber frame via `detect()`; a real
        timetagger would yield a continuous stream here and the daemon would
        segment frames using the sync string. Present so the class satisfies
        the driver contract; not exercised by the emulated daemon.
        """
        return
        yield  # unreachable; marks this an async generator

    @property
    def clock(self) -> ClockModel:
        """The (test-visible) ground-truth clock the recovery must invert."""
        return self._clock

    def detect(self, frame: FiberFrame) -> list[Click]:
        """Detect one fiber frame's pulses; advance the fiber polarization."""
        if not self._running:
            msg = "detect() before start()"
            raise RuntimeError(msg)
        self._pol.step()
        return physics.detect(frame.pulses, self._cfg, self._clock, self._pol.angle_rad)
