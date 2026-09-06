"""Two-bench integration: source → fiber → detector → sift → pool.

Drives a SourceBench and DetectorBench over the in-memory fiber (no sockets),
proving the whole optical path end to end: transmitted qubits become recovered
detections that sift to a QBER well under threshold and accumulate a 128-bit
distillable pool — and that the run is bit-reproducible for a fixed seed.

Sifting here is a tiny local reimplementation (basis-match + QBER); the real
sift/distill lives in the browser and is tested in JS. This test's job is the
DAEMON contract: the click stream it produces is correct and distillable.
"""

import asyncio
import random

import pytest

from bench.config import BenchConfig, DetectorConfig, SyncConfig, TimingConfig
from bench.session import DetectorBench, SourceBench


def _cfg(role, seed):
    return BenchConfig(
        role=role,
        seed=seed,
        detector=DetectorConfig(efficiency=0.8, dark_rate_cps=50.0, jitter_sigma_ps=40.0, dead_time_ns=33.0),
        timing=TimingConfig(rep_rate_hz=100e6, slots_per_frame=10000, frame_period_ms=0.0),
        sync=SyncConfig(mode="qubit", sync_slots=2048, sync_blocks=16),
    )


def _random_payload(n, r):
    return tuple(r.randint(0, 1) for _ in range(n)), tuple(r.randint(0, 1) for _ in range(n))


async def _run(seed, n_frames=6):
    """Transmit n_frames end to end; return (pool_bits, qber, sift_count)."""
    # Shared in-memory fiber: whatever the source sends, the detector receives.
    sent: list[bytes] = []

    async def send_fiber(frame: bytes) -> None:
        sent.append(frame)

    source = SourceBench(_cfg("source", seed), send_fiber)
    detector = DetectorBench(_cfg("detector", seed))
    await detector.start()

    r_payload = random.Random(seed * 7 + 1)
    payload_slots = _cfg("source", seed).timing.slots_per_frame - 2048

    pool: list[int] = []
    matched = mismatched = 0
    for frame_id in range(n_frames):
        bits, bases = _random_payload(payload_slots, r_payload)
        await source.transmit(frame_id, bits, bases)
        recovered = detector.process(sent[frame_id])
        # Sift: the detector only knows its (slot, basis, bit); the source
        # discloses its basis at those slots (as the browser protocol does).
        for det in recovered.detections:
            if det.slot >= payload_slots:
                continue
            if det.basis == bases[det.slot]:
                pool.append(det.bit)
                if det.bit == bits[det.slot]:
                    matched += 1
                else:
                    mismatched += 1
    total = matched + mismatched
    qber = mismatched / total if total else 1.0
    return pool, qber, total


@pytest.mark.integration
def test_end_to_end_accumulates_a_distillable_pool():
    pool, qber, total = asyncio.run(_run(seed=42))
    assert total > 200, "too few sifted bits — detection path is broken"
    assert qber < 0.06, f"QBER {qber:.3f} above a clean-channel budget"
    # A 128-bit key needs pool − ceil(pool/8) − 64 ≥ 128 bits; a handful of
    # frames must clear that.
    assert len(pool) - (len(pool) + 7) // 8 - 64 >= 128


@pytest.mark.integration
def test_run_is_bit_reproducible():
    a = asyncio.run(_run(seed=99))
    b = asyncio.run(_run(seed=99))
    assert a[0] == b[0], "same seed must yield an identical sifted pool"
    assert a[1] == b[1]


@pytest.mark.integration
def test_eavesdropper_poisons_the_pool():
    async def run():
        sent: list[bytes] = []

        async def send_fiber(frame: bytes) -> None:
            sent.append(frame)

        seed = 7
        source = SourceBench(_cfg("source", seed), send_fiber)
        detector = DetectorBench(_cfg("detector", seed))
        await detector.start()
        source.set_eavesdropper(enabled=True)

        r = random.Random(123)
        payload_slots = _cfg("source", seed).timing.slots_per_frame - 2048
        matched = mismatched = 0
        for frame_id in range(4):
            bits, bases = _random_payload(payload_slots, r)
            await source.transmit(frame_id, bits, bases)
            recovered = detector.process(sent[frame_id])
            for det in recovered.detections:
                if det.slot < payload_slots and det.basis == bases[det.slot]:
                    if det.bit == bits[det.slot]:
                        matched += 1
                    else:
                        mismatched += 1
        return mismatched / (matched + mismatched)

    qber = asyncio.run(run())
    assert qber > 0.15, f"Eve QBER {qber:.3f} should be unmistakable"
