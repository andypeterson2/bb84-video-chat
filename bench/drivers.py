"""Instrument driver contracts — the hardware swap surface.

Everything above these abstract base classes (framing, slot recovery, clock
alignment, the fiber link, the WebSocket protocol, the daemon itself) is
emulator-independent. Swapping to real optics means writing concrete drivers
against these ABCs — an AWG/laser driver, a timetagger SDK wrapper, a
polarization-controller driver — and configuring the fiber-link stanza off.
Nothing else changes.

This module is the deliverable of the whole effort: `docs/HARDWARE.md`
documents these contracts, their units, and clock semantics.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

# Detector identity encodes the measured basis and bit over four SPADs:
#   0 = Z/H (basis 0, bit 0)   1 = Z/V (basis 0, bit 1)
#   2 = X/D (basis 1, bit 0)   3 = X/A (basis 1, bit 1)
DETECTOR_BASIS = (0, 0, 1, 1)
DETECTOR_BIT = (0, 1, 0, 1)


def detector_id(basis: int, bit: int) -> int:
    """Map a (basis, bit) measurement to its SPAD channel id."""
    return basis * 2 + bit


@dataclass(frozen=True, slots=True)
class TransmitFrame:
    """One frame to prepare and fire from the source bench.

    `bits` and `bases` are one value (0/1) per pulse slot; `slots` is their
    length. `frame_id` is monotonic and carried in the fiber framing so the
    detector can label its acquisition (it is NOT used for slot recovery —
    that runs from the sync string / shared clock alone).
    """

    frame_id: int
    slots: int
    bits: tuple[int, ...]
    bases: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class FrameTxReport:
    """Result of firing a frame: when it went out, in the source clock."""

    frame_id: int
    tx_epoch_ps: int


@dataclass(frozen=True, slots=True)
class Click:
    """One detection event as a timetagger reports it.

    `t_ps` is the arrival time in the tagger's own clock (picoseconds, no
    external time reference); `detector_id` is the SPAD that fired. Slot
    recovery turns a stream of these into (slot, basis, bit) records.
    """

    t_ps: int
    detector_id: int


class PulseSourceDriver(abc.ABC):
    """Drives the pulsed source: prepares a frame's states and fires them.

    Real implementation: program the AWG driving the polarization modulator,
    set the attenuator, trigger off the mode-locked laser clock. Emulated
    implementation: render the pattern to pulse records and hand them to the
    fiber link.
    """

    @abc.abstractmethod
    def configure(self, config: object) -> None:
        """Apply bench configuration (rep rate, intensities, ...)."""

    @abc.abstractmethod
    async def arm(self, frame: TransmitFrame) -> None:
        """Load a frame's prepared states, ready to fire."""

    @abc.abstractmethod
    async def fire(self) -> FrameTxReport:
        """Emit the armed frame; return when it has left the source."""


class TimeTaggerDriver(abc.ABC):
    """Reads the detector bank: yields raw click timestamps.

    Real implementation: wrap the timetagger SDK (Swabian, PicoQuant, ...).
    Emulated implementation: consume fiber records, apply detector physics
    and the clock transform, yield the resulting clicks.
    """

    #: Whether this bench has a hardware sync input (shared clock from the
    #: source laser). False ⇒ synchronization must be recovered from the
    #: qubit stream itself (Qubit4Sync).
    has_sync_input: bool = False

    @abc.abstractmethod
    def configure(self, config: object) -> None:
        """Apply detector configuration (efficiency, dark rate, gate, ...)."""

    @abc.abstractmethod
    async def start(self) -> None:
        """Begin acquisition."""

    @abc.abstractmethod
    async def stop(self) -> None:
        """End acquisition."""

    @abc.abstractmethod
    def clicks(self) -> AsyncIterator[Click]:
        """Async-iterate detection events as they arrive."""


class PolarizationCompensatorDriver(abc.ABC):
    """Tracks and cancels slow polarization drift on the fiber.

    Real implementation: motorized polarization controllers running a
    coordinate-descent search that minimizes QBER (as in the DTU field
    trial). Emulated implementation: periodically re-zero the modeled drift,
    with a configurable overshoot transient so the QBER strip chart shows the
    drift-and-recover the real bench exhibits.
    """

    @abc.abstractmethod
    def compensation_rad(self) -> float:
        """Current compensation angle applied to incoming polarization."""

    @abc.abstractmethod
    def step(self, observed_qber: float) -> None:
        """Advance the search one step given the latest observed QBER."""
