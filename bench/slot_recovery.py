"""Map recovered-clock clicks to pulse slots for the payload region.

Given an Alignment (t0, period) from alignment.py, assign each click to a
slot, drop clicks that fall outside their slot's detection gate (this is
where timing jitter and mis-tracked drift genuinely cost detections), keep
only the payload region (past the sync string), and emit sparse detection
records the daemon ships to the browser.

A one-tap drift tracker refines the period frame-over-frame from the residual
timing error, so a slowly drifting clock stays locked without re-running the
full alignment each frame.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from bench.drivers import DETECTOR_BASIS, DETECTOR_BIT, Click

if TYPE_CHECKING:
    from bench.alignment import Alignment


@dataclass(frozen=True, slots=True)
class Detection:
    """One recovered payload detection: slot, measured basis and bit."""

    slot: int
    basis: int
    bit: int


@dataclass(frozen=True, slots=True)
class RecoveryResult:
    """Payload detections plus the drift-refined period for the next frame."""

    detections: list[Detection]
    refined_period_ps: float
    residual_ps: float


def recover(
    clicks: list[Click],
    alignment: Alignment,
    *,
    sync_slots: int,
    payload_slots: int,
    gate_fraction: float,
) -> RecoveryResult:
    """Turn clicks into payload detections under the recovered alignment.

    Slots are assigned as round((t - t0) / period); a click is accepted only
    if it lands within `gate_fraction` of the slot centre. The mean signed
    in-gate residual refines the period (a slot-proportional timing error is
    exactly a period error).
    """
    t0 = alignment.t0_ps
    period = alignment.period_ps
    gate = gate_fraction * period
    total_slots = sync_slots + payload_slots

    detections: list[Detection] = []
    residual_sum = 0.0
    residual_n = 0
    # One detection per slot: the ordered, dead-timed click stream means the
    # first in-gate click wins; a later click in the same slot is a dark/echo.
    seen: set[int] = set()
    for c in clicks:
        rel = (c.t_ps - t0) / period
        slot = round(rel)
        if slot < 0 or slot >= total_slots or slot in seen:
            continue
        residual = c.t_ps - (t0 + slot * period)
        if abs(residual) > gate:
            continue
        seen.add(slot)
        # Drift shows as a residual that grows with slot index; accumulate the
        # slot-weighted residual to refine the period.
        residual_sum += residual * slot
        residual_n += slot * slot
        if slot >= sync_slots:
            detections.append(
                Detection(
                    slot - sync_slots,
                    DETECTOR_BASIS[c.detector_id],
                    DETECTOR_BIT[c.detector_id],
                ),
            )

    # Least-squares slope of residual vs slot ⇒ fractional period correction.
    correction = residual_sum / residual_n if residual_n else 0.0
    refined = period + correction
    mean_residual = (residual_sum / residual_n) if residual_n else 0.0
    detections.sort(key=lambda d: d.slot)
    return RecoveryResult(detections, refined, mean_residual)
