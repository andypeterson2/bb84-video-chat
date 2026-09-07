"""Unit tests for the daemon's building blocks: pairing, wire codecs,
WS packing, fiber framing."""

import pytest

from bench.fiber_wire import decode, encode
from bench.pairing import Pairing
from bench.physics import PulseRecord
from bench.ws_protocol import (
    b64,
    decode_indices,
    encode_indices,
    pack_bits,
    unb64,
    unpack_bits,
)


class TestPairing:
    def test_verify_accepts_the_minted_token(self):
        p = Pairing()
        assert p.verify(p.token)

    def test_wrong_token_is_refused(self):
        p = Pairing("known-token")
        assert not p.verify("guess")
        assert not p.verify(None)

    def test_verify_is_stateless(self):
        # The token holder carries no paired state, so nothing it stores can
        # leak one connection's pairing to another. verify is a pure check.
        p = Pairing("known-token")
        assert p.verify("known-token")
        assert not p.verify("wrong")
        assert p.verify("known-token")


class TestPacking:
    def test_bits_round_trip(self):
        bits = [1, 0, 1, 1, 0, 0, 1, 0, 1]
        assert unpack_bits(pack_bits(bits), len(bits)) == bits

    def test_indices_round_trip(self):
        idx = [0, 1, 7, 128, 129, 90000]
        assert decode_indices(encode_indices(idx)) == idx

    def test_indices_reject_non_increasing(self):
        with pytest.raises(ValueError, match="increasing"):
            encode_indices([3, 3])

    def test_decode_indices_rejects_garbage(self):
        with pytest.raises(ValueError, match=r"malformed|non-positive"):
            decode_indices(bytes([0x80]))

    def test_base64_round_trip(self):
        data = bytes(range(256))
        assert unb64(b64(data)) == data


class TestFiberWire:
    def test_frame_round_trips(self):
        pulses = [PulseRecord(0, 0, 1, 1), PulseRecord(5, 1, 0, 3), PulseRecord(99, 1, 1, 1)]
        raw = encode(frame_id=7, slots=100, tx_epoch_ps=123456, pulses=pulses)
        frame = decode(raw)
        assert frame.frame_id == 7
        assert frame.slots == 100
        assert frame.tx_epoch_ps == 123456
        assert frame.pulses == pulses

    def test_bad_magic_is_rejected(self):
        with pytest.raises(ValueError, match="magic"):
            decode(b"XXXX" + bytes(40))

    def test_truncated_frame_is_rejected(self):
        raw = encode(1, 10, 0, [PulseRecord(0, 0, 0, 1)])
        with pytest.raises(ValueError, match="length"):
            decode(raw[:-1])

    def test_pulse_outside_frame_is_rejected(self):
        raw = encode(1, 10, 0, [PulseRecord(0, 0, 0, 1)])
        # Corrupt the slot field of the single record to be past `slots`.
        import struct

        from bench.fiber_wire import _HEADER

        bad = bytearray(raw)
        struct.pack_into("<I", bad, _HEADER.size, 999)
        with pytest.raises(ValueError, match="outside frame"):
            decode(bytes(bad))
