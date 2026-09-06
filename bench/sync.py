"""Public synchronization string (Qubit4Sync).

Both benches derive an identical public sync string from a fixed seed — no
shared secret, no extra hardware, same intensity as signal pulses (which is
why a fixed pulsed source + static attenuator suffices; per-pulse intensity
modulation, which decoy states need, is deliberately NOT required here).

The source prepends this string to every frame; the detector correlates its
sync-region detections against the known string to recover the clock offset
(alignment.py). The string is Z-basis so a Z-measuring detector reads it
directly.
"""

from __future__ import annotations

import hashlib

# Fixed, public — identical on both benches. Not a secret; synchronization
# security comes from the authenticated classical channel, not this string.
_SYNC_SEED = b"qvc-qubit4sync-v1"


def sync_pattern(sync_slots: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    """Return (bits, bases) for the public sync string of `sync_slots` slots.

    Bases are all Z (0); bits are a deterministic pseudo-random 0/1 sequence.
    """
    out = bytearray()
    counter = 0
    while len(out) * 8 < sync_slots:
        out += hashlib.sha256(_SYNC_SEED + counter.to_bytes(4, "big")).digest()
        counter += 1
    bits = tuple((out[i >> 3] >> (7 - (i & 7))) & 1 for i in range(sync_slots))
    bases = (0,) * sync_slots
    return bits, bases
