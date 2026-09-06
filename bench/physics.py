"""Emulated optical physics: source emission and detection.

The pipeline mirrors a weak-coherent BB84 bench, one slot at a time:

  source:   photon count ~ Poisson(mu); only photon-bearing slots emit
  fiber:    each photon survives with the channel transmittance (binomial
            thinning — multi-photon statistics stay exact for future decoy
            work); a slow polarization rotation adds basis-dependent error
  detector: passive random measurement basis (50/50 beamsplitter); matched
            basis reads the prepared bit, mismatched basis is a coin flip;
            per-photon efficiency; timing jitter; per-detector dead time;
            plus dark counts sprinkled across the acquisition

Everything here is seeded per stage (see rng) so a run is bit-reproducible.
All rates and constants come from BenchConfig; nothing is hard-coded.

Expected numbers at the defaults (mu=0.1, 1 km @ 0.2 dB/km + 1 dB, eta=0.1):
P(click) ~= (1 - e^-mu) * T * eta ~= 0.72%, so a 1e5-slot frame yields ~720
signal clicks plus ~50 dark clicks; ~half survive basis sifting.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from bench import rng
from bench.drivers import Click, detector_id

if TYPE_CHECKING:
    from bench.clock import ClockModel
    from bench.config import BenchConfig


@dataclass(frozen=True, slots=True)
class PulseRecord:
    """A photon-bearing pulse leaving the source (pre-loss)."""

    slot: int
    basis: int
    bit: int
    photons: int


def emit(bits: tuple[int, ...], bases: tuple[int, ...], mu: float, r) -> list[PulseRecord]:
    """Source emission: draw a Poisson photon count per slot.

    Only slots that emit at least one photon produce a record; the rest are
    vacuum and never reach the wire.
    """
    records: list[PulseRecord] = []
    for slot, (bit, basis) in enumerate(zip(bits, bases, strict=True)):
        n = _poisson(mu, r)
        if n > 0:
            records.append(PulseRecord(slot, basis, bit, n))
    return records


def detect(
    records: list[PulseRecord],
    cfg: BenchConfig,
    clock: ClockModel,
    pol_offset_rad: float,
) -> list[Click]:
    """Full receive path: fiber loss → detection → clicks (detector clock).

    `records` are the photon-bearing pulses from the source (already past any
    Eve tap). Returns clicks sorted by detector-clock time, with dark counts
    merged in and dead time applied.
    """
    slot_ps = cfg.slot_period_ps()
    transmittance = cfg.fiber.transmittance()
    r_channel = rng.stream(cfg.seed, rng.STAGE_CHANNEL)
    r_detector = rng.stream(cfg.seed, rng.STAGE_DETECTOR)
    r_jitter = rng.stream(cfg.seed, rng.STAGE_JITTER)

    raw: list[Click] = []
    for rec in records:
        # Fiber loss: thin the photon count (each survives independently).
        survivors = sum(1 for _ in range(rec.photons) if r_channel.random() < transmittance)
        if survivors == 0:
            continue
        # Passive basis choice at the receiver (50/50 beamsplitter).
        measure_basis = 0 if r_detector.random() < 0.5 else 1
        # Detector efficiency: at least one surviving photon must fire.
        if r_detector.random() >= _click_prob(survivors, cfg.detector.efficiency):
            continue
        bit = _measured_bit(rec, measure_basis, pol_offset_rad, r_detector)
        t_alice = rec.slot * slot_ps + slot_ps / 2.0
        t_bob = clock.to_detector(t_alice) + r_jitter.gauss(0.0, cfg.detector.jitter_sigma_ps)
        raw.append(Click(round(t_bob), detector_id(measure_basis, bit)))

    raw.extend(_dark_counts(cfg, clock, len(records)))
    raw.sort(key=lambda c: c.t_ps)
    return _apply_dead_time(raw, cfg.detector.dead_time_ns)


def _measured_bit(rec: PulseRecord, measure_basis: int, pol_offset_rad: float, r) -> int:
    """Bit the detector reads for a pulse in the chosen measurement basis."""
    if measure_basis != rec.basis:
        # Wrong basis: outcome is uniformly random (simulated quantum coin).
        return 0 if r.random() < 0.5 else 1
    # Matched basis: correct bit, flipped with the polarization-misalignment
    # probability sin^2(theta) — the fiber's slow drift shows up here.
    if r.random() < math.sin(pol_offset_rad) ** 2:
        return rec.bit ^ 1
    return rec.bit


def _click_prob(survivors: int, efficiency: float) -> float:
    """Probability at least one of `survivors` photons is detected."""
    return 1.0 - (1.0 - efficiency) ** survivors


def _dark_counts(cfg: BenchConfig, clock: ClockModel, _n_records: int) -> list[Click]:
    """Poisson dark clicks across the frame's acquisition window."""
    r = rng.stream(cfg.seed, rng.STAGE_DARK)
    slot_ps = cfg.slot_period_ps()
    window_ps = slot_ps * cfg.timing.slots_per_frame
    window_s = window_ps * 1e-12
    n_detectors = 4
    expected = cfg.detector.dark_rate_cps * window_s * n_detectors
    count = _poisson(expected, r)
    base = clock.to_detector(0.0)
    return [Click(round(base + r.random() * window_ps), r.randrange(n_detectors)) for _ in range(count)]


def _apply_dead_time(clicks: list[Click], dead_time_ns: float) -> list[Click]:
    """Drop clicks that fall within a detector's dead time after its last."""
    if dead_time_ns <= 0:
        return clicks
    dead_ps = dead_time_ns * 1000.0
    last_fire: dict[int, float] = {}
    kept: list[Click] = []
    for c in clicks:
        prev = last_fire.get(c.detector_id)
        if prev is not None and c.t_ps - prev < dead_ps:
            continue
        last_fire[c.detector_id] = c.t_ps
        kept.append(c)
    return kept


def _poisson(lam: float, r) -> int:
    """Knuth's Poisson sampler (fine for the small means used here)."""
    if lam <= 0:
        return 0
    target = math.exp(-lam)
    k = 0
    p = 1.0
    while True:
        p *= r.random()
        if p <= target:
            return k
        k += 1
