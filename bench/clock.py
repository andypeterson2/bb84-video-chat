"""Clock relationship between the two benches.

The detector's timetagger runs on its own clock, offset from the source's by
an unknown constant and drifting slowly in frequency. The detector must
recover this relationship to map click times back to pulse slots; this module
is the ground-truth model the emulated timetagger applies (and that
slot_recovery.py must invert without peeking at it).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from bench import rng

if TYPE_CHECKING:
    from bench.config import BenchConfig


@dataclass(frozen=True, slots=True)
class ClockModel:
    """Maps a source-clock timestamp to the detector's clock.

    t_bob = offset_ps + t_alice * (1 + drift), with `drift` a small
    fractional frequency error.
    """

    offset_ps: int
    drift: float

    def to_detector(self, t_alice_ps: float) -> float:
        """Transform a source-clock time into the detector clock."""
        return self.offset_ps + t_alice_ps * (1.0 + self.drift)


def sample_clock(cfg: BenchConfig) -> ClockModel:
    """Draw the (offset, drift) the detector will have to recover.

    The offset is uniform across a full frame so alignment cannot assume it
    is small; the drift is uniform in ±drift_ppb_max.
    """
    r = rng.stream(cfg.seed, rng.STAGE_CLOCK)
    frame_span_ps = cfg.slot_period_ps() * cfg.timing.slots_per_frame
    offset = r.randint(-frame_span_ps // 2, frame_span_ps // 2)
    drift = r.uniform(-cfg.clock.drift_ppb_max, cfg.clock.drift_ppb_max) * 1e-9
    return ClockModel(offset, drift)
