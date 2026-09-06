"""Deterministic per-stage RNG.

One master seed is fanned into an independent stream per emulation stage, so
tests are bit-reproducible while stages stay statistically independent (the
source's photon draws don't perturb the detector's dark counts, etc.).
"""

from __future__ import annotations

import hashlib
import random

# Stable integer tags per stage — mixed into the master seed.
STAGE_SOURCE = 1
STAGE_EVE = 2
STAGE_CHANNEL = 3
STAGE_DETECTOR = 4
STAGE_DARK = 5
STAGE_JITTER = 6
STAGE_CLOCK = 7
STAGE_PREP = 8


def stream(master_seed: int, stage: int) -> random.Random:
    """An independent Random stream for one stage of one bench run."""
    mixed = hashlib.sha256(f"{master_seed}:{stage}".encode()).digest()
    return random.Random(int.from_bytes(mixed[:8], "big"))
