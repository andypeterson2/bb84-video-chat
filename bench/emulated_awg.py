"""Emulated pulsed source — a PulseSourceDriver over the fiber link.

Prepends the public sync string to each frame, draws Poisson photon counts,
applies the (optional) Eve tap, and ships the photon-bearing pulses down the
emulated fiber. The real driver programs an AWG + attenuator + modulator and
the fiber stanza is simply not configured.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from bench import physics, rng
from bench.drivers import FrameTxReport, PulseSourceDriver, TransmitFrame
from bench.eve import EveStrategy, NoEve
from bench.fiber_wire import encode
from bench.sync import sync_pattern

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from bench.config import BenchConfig


class EmulatedAWG(PulseSourceDriver):
    """Source driver backed by the physics model and the fiber link."""

    def __init__(self, cfg: BenchConfig, send_fiber: Callable[[bytes], Awaitable[None]]) -> None:
        """Build the emulated source over a fiber send callable."""
        self._cfg = cfg
        self._send = send_fiber
        self._eve: EveStrategy = NoEve()
        self._sync_bits, self._sync_bases = sync_pattern(cfg.sync.sync_slots)
        self._prep = rng.stream(cfg.seed, rng.STAGE_PREP)
        self._armed: TransmitFrame | None = None

    def configure(self, config: object) -> None:
        """No-op: the emulated source takes its parameters at construction."""

    def set_eavesdropper(self, strategy: EveStrategy) -> None:
        """Install (or clear) the fiber-tap attack."""
        self._eve = strategy

    async def arm(self, frame: TransmitFrame) -> None:
        """Load a frame's prepared states, ready to fire."""
        self._armed = frame

    async def fire(self) -> FrameTxReport:
        """Emit the armed frame down the fiber; return its tx report."""
        if self._armed is None:
            msg = "fire() before arm()"
            raise RuntimeError(msg)
        frame = self._armed
        self._armed = None
        # Full slot layout: public sync string, then the payload.
        full_bits = self._sync_bits + frame.bits
        full_bases = self._sync_bases + frame.bases
        total_slots = len(full_bits)
        records = physics.emit(full_bits, full_bases, self._cfg.source.mu, self._prep)
        records = self._eve.transform(records)
        tx_epoch_ps = frame.frame_id * total_slots * self._cfg.slot_period_ps()
        await self._send(encode(frame.frame_id, total_slots, tx_epoch_ps, records))
        return FrameTxReport(frame.frame_id, tx_epoch_ps)
