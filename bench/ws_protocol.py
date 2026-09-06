"""Browser↔daemon WebSocket message schemas (JSON text frames).

Message set (⇒ browser→daemon, ⇐ daemon→browser):
  ⇒ pair {token}                    ⇐ paired {role, bench, slots_per_frame,
                                              rep_rate_hz, sync_mode} | refused {reason}
  ⇒ start {}                        ⇐ started
  ⇒ stop {}                         ⇐ stopped
  ⇒ transmit {frame_id, bits, bases, slots}   (source)  ⇐ frame-sent {frame_id, tx_epoch_ps}
  ⇒ eve {enabled}                   (source)
  ⇐ detections {frame_id, indices, bits, bases, stats}  (detector)
  ⇐ status {stored, ...}            ⇐ error {code, detail}

`indices` is delta-varint+base64, `bits`/`bases` are packed+base64 — the same
sparse encoding the browser's frame protocol uses, so a detection message
stays a couple of KB even at 1e5 slots.
"""

from __future__ import annotations

import base64

# ── base64 / packing helpers (mirror the browser's packing.js) ──────────


def pack_bits(bits: list[int] | tuple[int, ...]) -> bytes:
    """Pack 0/1 values into bytes, MSB-first (mirrors the browser)."""
    out = bytearray((len(bits) + 7) // 8)
    for i, b in enumerate(bits):
        if b & 1:
            out[i >> 3] |= 1 << (7 - (i & 7))
    return bytes(out)


def unpack_bits(data: bytes, n: int) -> list[int]:
    """Unpack `n` MSB-first bits from bytes."""
    return [(data[i >> 3] >> (7 - (i & 7))) & 1 for i in range(n)]


def encode_indices(indices: list[int]) -> bytes:
    """Delta-varint encode a strictly-increasing index list."""
    out = bytearray()
    prev = -1
    for idx in indices:
        if idx <= prev:
            msg = "indices must be strictly increasing"
            raise ValueError(msg)
        delta = idx - prev
        prev = idx
        while delta >= 0x80:
            out.append((delta & 0x7F) | 0x80)
            delta >>= 7
        out.append(delta)
    return bytes(out)


def decode_indices(data: bytes) -> list[int]:
    """Decode a delta-varint index list; raises on malformed input."""
    indices: list[int] = []
    prev = -1
    i = 0
    while i < len(data):
        delta = 0
        shift = 0
        while True:
            if i >= len(data) or shift > 28:
                msg = "malformed varint index stream"
                raise ValueError(msg)
            b = data[i]
            i += 1
            delta |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        if delta <= 0:
            msg = "non-positive index delta"
            raise ValueError(msg)
        prev += delta
        indices.append(prev)
    return indices


def b64(data: bytes) -> str:
    """Base64-encode bytes to an ASCII string."""
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    """Base64-decode a string; raises on non-base64 input."""
    return base64.b64decode(text, validate=True)


# ── message builders ────────────────────────────────────────────────────


def paired(cfg) -> dict:
    """Build the `paired` reply advertising this bench's capabilities."""
    return {
        "t": "paired",
        "role": cfg.role,
        "bench": "emulated",
        "slots_per_frame": cfg.timing.slots_per_frame,
        "rep_rate_hz": cfg.timing.rep_rate_hz,
        "sync_mode": cfg.sync.mode,
        "proto_v": 1,
    }


def refused(reason: str) -> dict:
    """Build a `refused` reply (bad token or unpaired)."""
    return {"t": "refused", "reason": reason}


def frame_sent(frame_id: int, tx_epoch_ps: int) -> dict:
    """Build the source-side `frame-sent` acknowledgement."""
    return {"t": "frame-sent", "frame_id": frame_id, "tx_epoch_ps": tx_epoch_ps}


def detections(frame_id: int, dets, stats: dict) -> dict:
    """Encode payload detections (list of slot_recovery.Detection) sparsely."""
    dets = sorted(dets, key=lambda d: d.slot)
    return {
        "t": "detections",
        "frame_id": frame_id,
        "indices": b64(encode_indices([d.slot for d in dets])),
        "bits": b64(pack_bits([d.bit for d in dets])),
        "bases": b64(pack_bits([d.basis for d in dets])),
        "count": len(dets),
        "stats": stats,
    }


def error(code: str, detail: str) -> dict:
    """Build an `error` reply."""
    return {"t": "error", "code": code, "detail": detail}
