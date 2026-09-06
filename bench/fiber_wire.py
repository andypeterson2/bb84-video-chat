"""Binary framing for the emulated fiber link.

The source daemon serializes each frame's photon-bearing pulses into a
length-prefixed binary record and the detector daemon parses it. This models
the physical fiber: only slots that emitted a photon appear on the wire, and
the frame header carries the timing metadata a real acquisition would need.

The frame_id / tx_epoch in the header are the detector's ACQUISITION LABEL and
test ground truth only — slot recovery never reads them (it runs from the sync
string and the recovered clock alone), so this stays the code that ships to
the real bench.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

from bench.physics import PulseRecord

_MAGIC = b"QVCF"
_HEADER = struct.Struct("<4sBQIQI")  # magic, version, frame_id, slots, tx_epoch_ps, pulse_count
_RECORD = struct.Struct("<IB")  # slot, flags
_VERSION = 1
_MAX_PULSES = 1 << 22  # sanity bound against a hostile/garbled peer

# flags byte: basis(bit0) | bit(bit1) | photons(bits2-5, clamped 1..15)
_PHOTON_CAP = 15


@dataclass(frozen=True, slots=True)
class FiberFrame:
    """A decoded fiber frame: its label, geometry, and photon-bearing pulses."""

    frame_id: int
    slots: int
    tx_epoch_ps: int
    pulses: list[PulseRecord]


def encode(frame_id: int, slots: int, tx_epoch_ps: int, pulses: list[PulseRecord]) -> bytes:
    """Serialize a fiber frame to bytes (length-prefixed by the caller)."""
    body = bytearray(_HEADER.pack(_MAGIC, _VERSION, frame_id, slots, tx_epoch_ps, len(pulses)))
    for p in pulses:
        photons = min(_PHOTON_CAP, max(1, p.photons))
        flags = (p.basis & 1) | ((p.bit & 1) << 1) | (photons << 2)
        body += _RECORD.pack(p.slot, flags)
    return bytes(body)


def decode(data: bytes) -> FiberFrame:
    """Parse a fiber frame; raises ValueError on anything malformed."""
    if len(data) < _HEADER.size:
        msg = "fiber frame shorter than header"
        raise ValueError(msg)
    magic, version, frame_id, slots, tx_epoch_ps, count = _HEADER.unpack_from(data, 0)
    if magic != _MAGIC:
        msg = "bad fiber frame magic"
        raise ValueError(msg)
    if version != _VERSION:
        msg = f"unsupported fiber frame version {version}"
        raise ValueError(msg)
    if count > _MAX_PULSES or count > slots:
        msg = "implausible pulse count"
        raise ValueError(msg)
    expected = _HEADER.size + count * _RECORD.size
    if len(data) != expected:
        msg = f"fiber frame length {len(data)} != expected {expected}"
        raise ValueError(msg)
    pulses: list[PulseRecord] = []
    off = _HEADER.size
    for _ in range(count):
        slot, flags = _RECORD.unpack_from(data, off)
        off += _RECORD.size
        if slot >= slots:
            msg = "pulse slot outside frame"
            raise ValueError(msg)
        pulses.append(PulseRecord(slot, flags & 1, (flags >> 1) & 1, (flags >> 2) & _PHOTON_CAP))
    return FiberFrame(frame_id, slots, tx_epoch_ps, pulses)
