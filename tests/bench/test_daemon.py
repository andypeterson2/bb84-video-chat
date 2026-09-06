"""BenchConnection message handling and the full daemon path, transport-free.

Drives the source and detector BenchConnections directly (fake `send`s, an
in-memory fiber between them) so pairing, transmit/frame-sent, the eve control,
and the detector→browser detections push are all covered without `websockets`.
"""

import asyncio
import json

from bench.config import BenchConfig, DetectorConfig, SyncConfig, TimingConfig
from bench.daemon import BenchConnection, origin_allowed
from bench.pairing import Pairing
from bench.session import DetectorBench, SourceBench
from bench.ws_protocol import b64, pack_bits


def _cfg(role, seed=1):
    return BenchConfig(
        role=role,
        seed=seed,
        detector=DetectorConfig(efficiency=0.8, dark_rate_cps=50.0, jitter_sigma_ps=40.0, dead_time_ns=33.0),
        timing=TimingConfig(rep_rate_hz=100e6, slots_per_frame=8000, frame_period_ms=0.0),
        sync=SyncConfig(mode="qubit", sync_slots=2048, sync_blocks=16),
    )


class Sink:
    """Collects messages a connection would send to its browser."""

    def __init__(self):
        self.msgs = []

    async def __call__(self, m):
        self.msgs.append(m)

    def last(self, kind):
        return next((m for m in reversed(self.msgs) if m["t"] == kind), None)


def test_origin_allowlist():
    allowed = ("http://localhost", "https://andypeterson.dev")
    assert origin_allowed("http://localhost", allowed)
    assert origin_allowed("http://localhost:8077", allowed)  # explicit port ok
    assert origin_allowed("https://andypeterson.dev", allowed)
    assert not origin_allowed("http://evil.test", allowed)
    assert not origin_allowed(None, allowed)


def test_origin_allowlist_rejects_prefix_lookalikes():
    # A bare startswith test would accept these against the allowlist entries.
    allowed = ("http://localhost", "https://andypeterson.dev")
    assert not origin_allowed("http://localhost.evil.com", allowed)
    assert not origin_allowed("http://localhostevil.com", allowed)
    assert not origin_allowed("https://andypeterson.dev.evil.com", allowed)
    assert not origin_allowed("", allowed)
    assert not origin_allowed("http://localhost", ("",))  # empty entry never matches


def test_must_pair_before_anything():
    async def run():
        sink = Sink()
        pairing = Pairing()
        conn = BenchConnection(_cfg("source"), pairing, sink, source=SourceBench(_cfg("source"), _noop))
        await conn.on_message(json.dumps({"t": "transmit", "frame_id": 0, "slots": 1, "bits": "AA", "bases": "AA"}))
        assert sink.last("refused") is not None

    asyncio.run(run())


def test_bad_token_refused_good_token_paired():
    async def run():
        sink = Sink()
        pairing = Pairing("secret-token")
        conn = BenchConnection(_cfg("source"), pairing, sink, source=SourceBench(_cfg("source"), _noop))
        await conn.on_message(json.dumps({"t": "pair", "token": "wrong"}))
        assert sink.last("refused") is not None
        await conn.on_message(json.dumps({"t": "pair", "token": "secret-token"}))
        assert sink.last("paired") is not None
        assert sink.last("paired")["role"] == "source"

    asyncio.run(run())


def test_second_connection_does_not_inherit_pairing():
    """Two connections share one Pairing (the single printed token) but not
    paired state. A second, unpaired connection must present the token itself —
    it cannot ride on the first's pairing — and the first stays paired
    regardless of what the second does. The old shared-`_paired` bool failed
    both halves: B saw is_paired True after A paired, and B's connect/close
    reset A. The transport-free tests missed it by using a fresh Pairing per
    connection; here both share one, as the live daemon wires them.
    """

    async def run():
        pairing = Pairing("shared-token")
        a_sink, b_sink = Sink(), Sink()
        conn_a = BenchConnection(_cfg("source"), pairing, a_sink, source=SourceBench(_cfg("source"), _noop))
        conn_b = BenchConnection(_cfg("source"), pairing, b_sink, source=SourceBench(_cfg("source"), _noop))

        # A pairs with the shared token.
        await conn_a.on_message(json.dumps({"t": "pair", "token": "shared-token"}))
        assert a_sink.last("paired") is not None

        # B, without pairing, is refused a control even though A is paired —
        # no auth bypass from the shared object.
        await conn_b.on_message(json.dumps({"t": "eve", "enabled": True}))
        assert b_sink.last("refused") is not None
        assert b_sink.last("paired") is None

        # A is still paired after B's activity — no shared reset / pairing DoS.
        a_sink.msgs.clear()
        await conn_a.on_message(json.dumps({"t": "eve", "enabled": True}))
        assert a_sink.last("refused") is None

    asyncio.run(run())


async def _noop(_frame):
    pass


def test_full_path_source_to_detector_to_browser():
    async def run():
        seed = 3
        src_cfg = _cfg("source", seed)
        det_cfg = _cfg("detector", seed)

        # In-memory fiber: the source connection's fiber send feeds the
        # detector connection's on_fiber_frame.
        detector_bench = DetectorBench(det_cfg)
        det_sink = Sink()
        det_pairing = Pairing()
        det_conn = BenchConnection(det_cfg, det_pairing, det_sink, detector=detector_bench)

        async def fiber_send(frame: bytes) -> None:
            await det_conn.on_fiber_frame(frame)

        source_bench = SourceBench(src_cfg, fiber_send)
        src_sink = Sink()
        src_pairing = Pairing()
        src_conn = BenchConnection(src_cfg, src_pairing, src_sink, source=source_bench)

        # Pair both, start the detector acquisition.
        await src_conn.on_message(json.dumps({"t": "pair", "token": src_pairing.token}))
        await det_conn.on_message(json.dumps({"t": "pair", "token": det_pairing.token}))
        await det_conn.on_message(json.dumps({"t": "start"}))
        assert det_sink.last("started") is not None

        # Transmit a frame from the browser via the source connection.
        payload = 8000 - 2048
        import random

        r = random.Random(seed)
        bits = [r.randint(0, 1) for _ in range(payload)]
        bases = [r.randint(0, 1) for _ in range(payload)]
        await src_conn.on_message(
            json.dumps(
                {
                    "t": "transmit",
                    "frame_id": 0,
                    "slots": payload,
                    "bits": b64(pack_bits(bits)),
                    "bases": b64(pack_bits(bases)),
                },
            ),
        )
        assert src_sink.last("frame-sent") is not None

        # The detector connection pushed a detections message to its browser.
        det = det_sink.last("detections")
        assert det is not None
        assert det["frame_id"] == 0
        assert det["count"] > 50
        assert det["stats"]["lock"]["quality"] > 0.5

    asyncio.run(run())


def test_eve_control_is_source_only():
    async def run():
        det_sink = Sink()
        det_pairing = Pairing()
        det_conn = BenchConnection(_cfg("detector"), det_pairing, det_sink, detector=DetectorBench(_cfg("detector")))
        await det_conn.on_message(json.dumps({"t": "pair", "token": det_pairing.token}))
        await det_conn.on_message(json.dumps({"t": "eve", "enabled": True}))
        assert det_sink.last("error")["code"] == "wrong_role"

    asyncio.run(run())
