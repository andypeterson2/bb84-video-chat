"""End-to-end emulation core: emit → detect → align → recover.

Proves the genuinely-hard code (clock alignment + slot recovery) inverts the
ground-truth clock model without ever seeing it, and that recovered payload
detections agree with the transmitted qubits at the expected QBER.
"""

import math

from bench import physics, rng
from bench.alignment import align
from bench.clock import sample_clock
from bench.config import BenchConfig, DetectorConfig, SyncConfig, TimingConfig
from bench.slot_recovery import recover
from bench.sync import sync_pattern


def _snspd_cfg(seed=1):
    # SNSPD-like preset: high efficiency, low dark — a clean channel so the
    # recovery math is tested without being swamped by noise.
    return BenchConfig(
        role="detector",
        seed=seed,
        detector=DetectorConfig(efficiency=0.8, dark_rate_cps=50.0, jitter_sigma_ps=40.0, dead_time_ns=33.0),
        timing=TimingConfig(rep_rate_hz=100e6, slots_per_frame=12000, frame_period_ms=0.0),
        sync=SyncConfig(mode="qubit", sync_slots=2048, sync_blocks=16),
    )


def _run_frame(cfg, payload_bits, payload_bases):
    """Emit a full [sync || payload] frame, detect it, recover the payload."""
    sync_bits, sync_bases = sync_pattern(cfg.sync.sync_slots)
    full_bits = sync_bits + payload_bits
    full_bases = sync_bases + payload_bases
    r_prep = rng.stream(cfg.seed, rng.STAGE_SOURCE)
    records = physics.emit(full_bits, full_bases, cfg.source.mu, r_prep)

    clock = sample_clock(cfg)
    clicks = physics.detect(records, cfg, clock, pol_offset_rad=0.0)

    alignment = align(clicks, sync_bits, cfg.slot_period_ps())
    result = recover(
        clicks,
        alignment,
        sync_slots=cfg.sync.sync_slots,
        payload_slots=len(payload_bits),
        gate_fraction=cfg.detector.gate_fraction,
    )
    return alignment, result, clock


def _payload(n, seed=7):
    import random

    r = random.Random(seed)
    bits = tuple(r.randint(0, 1) for _ in range(n))
    bases = tuple(r.randint(0, 1) for _ in range(n))
    return bits, bases


def test_alignment_recovers_the_unknown_offset():
    cfg = _snspd_cfg()
    payload_bits, payload_bases = _payload(10000)
    alignment, _result, clock = _run_frame(cfg, payload_bits, payload_bases)
    # t0 should land within a slot of the true offset (source slot 0 maps to
    # clock.to_detector(slot_ps/2)).
    true_t0 = clock.to_detector(cfg.slot_period_ps() / 2.0)
    assert abs(alignment.t0_ps - true_t0) < cfg.slot_period_ps()
    assert alignment.quality > 0.5  # sync clearly locked


def test_recovered_detections_match_transmitted_bits_on_matched_basis():
    cfg = _snspd_cfg()
    payload_bits, payload_bases = _payload(10000)
    _alignment, result, _clock = _run_frame(cfg, payload_bits, payload_bases)

    assert len(result.detections) > 100  # real detection yield
    matched = mismatched = 0
    for d in result.detections:
        if d.slot >= len(payload_bits):
            continue
        if d.basis == payload_bases[d.slot]:
            if d.bit == payload_bits[d.slot]:
                matched += 1
            else:
                mismatched += 1
    total = matched + mismatched
    assert total > 50
    qber = mismatched / total
    # Clean channel (no Eve, no pol drift): QBER dominated by rare dark/gate
    # coincidences — comfortably below the 11% threshold.
    assert qber < 0.05, f"QBER {qber:.3f} too high"


def test_eve_intercept_resend_lifts_the_qber():
    cfg = _snspd_cfg(seed=3)
    payload_bits, payload_bases = _payload(10000, seed=11)
    sync_bits, sync_bases = sync_pattern(cfg.sync.sync_slots)
    full_bits = sync_bits + payload_bits
    full_bases = sync_bases + payload_bases
    r_prep = rng.stream(cfg.seed, rng.STAGE_SOURCE)
    records = physics.emit(full_bits, full_bases, cfg.source.mu, r_prep)

    from bench.eve import InterceptResend

    tapped = InterceptResend(cfg.seed).transform(records)
    clock = sample_clock(cfg)
    clicks = physics.detect(tapped, cfg, clock, pol_offset_rad=0.0)
    alignment = align(clicks, sync_bits, cfg.slot_period_ps())
    result = recover(
        clicks,
        alignment,
        sync_slots=cfg.sync.sync_slots,
        payload_slots=len(payload_bits),
        gate_fraction=cfg.detector.gate_fraction,
    )
    matched = mismatched = 0
    for d in result.detections:
        if d.slot < len(payload_bits) and d.basis == payload_bases[d.slot]:
            if d.bit == payload_bits[d.slot]:
                matched += 1
            else:
                mismatched += 1
    qber = mismatched / (matched + mismatched)
    # Intercept-resend on matched-basis pulses lands near 25%.
    assert qber > 0.15, f"Eve QBER {qber:.3f} too low"


def test_drift_tracker_refines_the_period_toward_truth():
    cfg = _snspd_cfg(seed=5)
    payload_bits, payload_bases = _payload(10000, seed=13)
    alignment, result, clock = _run_frame(cfg, payload_bits, payload_bases)
    true_period = cfg.slot_period_ps() * (1.0 + clock.drift)
    # The refined period should be at least as close to truth as the nominal.
    nominal_err = abs(cfg.slot_period_ps() - true_period)
    refined_err = abs(result.refined_period_ps - true_period)
    assert refined_err <= nominal_err + 1e-6
    assert math.isfinite(result.refined_period_ps)
