"""Eavesdropper middlebox on the emulated fiber.

Installed in the source daemon's fiber TX path (records → transform → wire),
toggled by the source-side user's UI control. Physically this is an attacker
sitting near the source, before channel loss — which is where the tap belongs.

Pluggable via the EveStrategy protocol so later attacks (photon-number
splitting, selective) slot in without touching the fiber layer.
"""

from __future__ import annotations

from typing import Protocol

from bench import rng
from bench.physics import PulseRecord


class EveStrategy(Protocol):
    """A fiber-tap attack: rewrite the pulse records in flight."""

    def transform(self, records: list[PulseRecord]) -> list[PulseRecord]:
        """Return the (possibly altered) records to send onward."""
        ...


class InterceptResend:
    """Classic intercept-resend: measure in a random basis, re-prepare.

    A wrong-basis measurement randomizes the re-prepared state, so a matched
    basis at the receiver reads the correct bit only half the time — driving
    the matched-basis error rate toward 25%.
    """

    def __init__(self, seed: int) -> None:
        """Seed the attacker's measurement RNG."""
        self._rng = rng.stream(seed, rng.STAGE_EVE)

    def transform(self, records: list[PulseRecord]) -> list[PulseRecord]:
        """Measure each pulse in a random basis and re-prepare it."""
        out: list[PulseRecord] = []
        for rec in records:
            eve_basis = 0 if self._rng.random() < 0.5 else 1
            # Matched basis: Eve reads the true bit. Wrong basis: her outcome
            # is random, and that is what she re-prepares (in her basis).
            if eve_basis == rec.basis:
                bit = rec.bit
            elif self._rng.random() < 0.5:
                bit = 0
            else:
                bit = 1
            # She re-emits a single-photon state in her measured basis.
            out.append(PulseRecord(rec.slot, eve_basis, bit, 1))
        return out


class NoEve:
    """Pass-through: the honest channel."""

    def transform(self, records: list[PulseRecord]) -> list[PulseRecord]:
        """Return the records unchanged (honest channel)."""
        return records
