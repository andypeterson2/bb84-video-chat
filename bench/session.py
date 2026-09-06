"""Bench session logic — the daemon's brain, transport-free.

`SourceBench` turns a browser transmit request into fiber output; `DetectorBench`
turns a received fiber frame into recovered payload detections. Both are pure
async objects with no WebSocket knowledge, so the daemon wires transport around
them and the integration test drives them directly over an in-memory fiber.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from bench.alignment import align
from bench.drivers import FrameTxReport, TransmitFrame
from bench.emulated_awg import EmulatedAWG
from bench.emulated_timetagger import EmulatedTimeTagger
from bench.eve import InterceptResend, NoEve
from bench.fiber_wire import FiberFrame, decode
from bench.slot_recovery import Detection, recover
from bench.sync import sync_pattern

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from bench.config import BenchConfig


class SourceBench:
    """Source side: prepare + fire frames down the fiber."""

    def __init__(self, cfg: BenchConfig, send_fiber: Callable[[bytes], Awaitable[None]]) -> None:
        """Wire the source bench to a fiber send callable."""
        if cfg.role != "source":
            msg = "SourceBench requires role='source'"
            raise ValueError(msg)
        self._cfg = cfg
        self._awg = EmulatedAWG(cfg, send_fiber)

    async def transmit(
        self,
        frame_id: int,
        bits: tuple[int, ...],
        bases: tuple[int, ...],
    ) -> FrameTxReport:
        """Prepare and fire one frame; return its tx report."""
        await self._awg.arm(TransmitFrame(frame_id, len(bits), bits, bases))
        return await self._awg.fire()

    def set_eavesdropper(self, *, enabled: bool) -> None:
        """Toggle the intercept-resend fiber tap."""
        self._awg.set_eavesdropper(InterceptResend(self._cfg.seed) if enabled else NoEve())


@dataclass(frozen=True, slots=True)
class RecoveredFrame:
    """A detector-recovered frame: payload detections + acquisition stats."""

    frame_id: int
    payload_slots: int
    detections: list[Detection]
    stats: dict


class DetectorBench:
    """Detector side: recover payload detections from fiber frames.

    Carries the drift-refined period between frames so a slowly drifting clock
    stays locked without re-deriving the frequency each acquisition.
    """

    def __init__(self, cfg: BenchConfig) -> None:
        """Set up the detector bench and its drift-tracked period."""
        if cfg.role != "detector":
            msg = "DetectorBench requires role='detector'"
            raise ValueError(msg)
        self._cfg = cfg
        self._tagger = EmulatedTimeTagger(cfg)
        self._sync_bits, _ = sync_pattern(cfg.sync.sync_slots)
        self._period_ps = float(cfg.slot_period_ps())
        self._started = False

    async def start(self) -> None:
        """Begin acquisition."""
        await self._tagger.start()
        self._started = True

    async def stop(self) -> None:
        """End acquisition."""
        await self._tagger.stop()
        self._started = False

    @property
    def tagger(self) -> EmulatedTimeTagger:
        """Test access to the ground-truth clock the recovery inverts."""
        return self._tagger

    def process(self, raw: bytes) -> RecoveredFrame:
        """Decode a fiber frame, detect, align, and recover the payload."""
        frame: FiberFrame = decode(raw)
        clicks = self._tagger.detect(frame)
        sync_slots = self._cfg.sync.sync_slots
        payload_slots = frame.slots - sync_slots

        alignment = align(clicks, self._sync_bits, self._period_ps)
        result = recover(
            clicks,
            alignment,
            sync_slots=sync_slots,
            payload_slots=payload_slots,
            gate_fraction=self._cfg.detector.gate_fraction,
        )
        # Carry the refined period into the next frame (bounded to a sane band
        # so a pathological frame can't run the tracker away).
        nominal = float(self._cfg.slot_period_ps())
        self._period_ps = min(max(result.refined_period_ps, nominal * 0.99), nominal * 1.01)

        stats = {
            "clicks": len(clicks),
            "detections": len(result.detections),
            "lock": {"quality": round(alignment.quality, 3), "residual_ps": round(result.residual_ps, 1)},
        }
        return RecoveredFrame(frame.frame_id, payload_slots, result.detections, stats)
