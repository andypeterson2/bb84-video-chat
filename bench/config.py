"""Bench daemon configuration (TOML via stdlib tomllib).

Every physics knob, timing parameter, and network setting lives here with a
documented default, so `bench.toml.example` is the single reference for how
the emulated bench behaves. Loaded once at startup into frozen dataclasses.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path


@dataclass(frozen=True, slots=True)
class SourceConfig:
    """Pulsed-source parameters."""

    #: Mean photon number per signal pulse (Poisson). 0.1 is a conservative
    #: weak-coherent value; the sync string uses the same intensity.
    mu: float = 0.1


@dataclass(frozen=True, slots=True)
class FiberConfig:
    """Channel loss between the benches."""

    length_km: float = 1.0
    attenuation_db_per_km: float = 0.2
    insertion_db: float = 1.0
    #: Slow polarization rotation random-walk on the fiber (rad/s). The
    #: dominant QBER dynamic on a real deployed link.
    pol_drift_rad_per_s: float = 0.02

    def transmittance(self) -> float:
        """Fraction of photons that survive the fiber (per photon)."""
        db = self.attenuation_db_per_km * self.length_km + self.insertion_db
        return 10.0 ** (-db / 10.0)


@dataclass(frozen=True, slots=True)
class DetectorConfig:
    """Single-photon detector bank parameters.

    Defaults model an APD teaching bench; the `snspd` preset in
    bench.toml.example models the DTU-like superconducting detectors.
    """

    efficiency: float = 0.1
    dark_rate_cps: float = 25_000.0
    jitter_sigma_ps: float = 350.0
    dead_time_ns: float = 50.0
    #: Detection gate half-width as a fraction of the slot period. A click
    #: outside the recovered slot's gate is dropped (this is where jitter and
    #: mis-tracked drift genuinely cost detections).
    gate_fraction: float = 0.4


@dataclass(frozen=True, slots=True)
class ClockConfig:
    """Alice↔Bob clock relationship the detector must recover."""

    #: Frequency offset between the benches, parts-per-billion, drawn in
    #: ±drift_ppb_max at startup (unknown to the detector).
    drift_ppb_max: float = 5_000.0
    #: Optional slow random-walk of the drift (ppb per second).
    drift_walk_ppb_per_s: float = 0.0


@dataclass(frozen=True, slots=True)
class TimingConfig:
    """Frame cadence and pulse rate."""

    rep_rate_hz: float = 100e6
    slots_per_frame: int = 100_000
    #: Wall-clock spacing between frames (the bench idles between batched
    #: acquisitions). 0 ⇒ free-run (tests).
    frame_period_ms: float = 250.0


@dataclass(frozen=True, slots=True)
class SyncConfig:
    """How the detector synchronizes to the source.

    'shared-clock': a clock side-channel rides the fiber (DTU-style FPGA
    service channel) — recovery reduces to offset + slow-drift tracking.
    'qubit': no extra hardware — recover period and offset from a public
    synchronization string at signal intensity (Qubit4Sync).
    """

    mode: str = "qubit"
    #: Public sync-string length in slots (qubit mode). Split into blocks for
    #: the blockwise cross-correlation.
    sync_slots: int = 2_048
    sync_blocks: int = 16


@dataclass(frozen=True, slots=True)
class NetConfig:
    """WebSocket (browser) and fiber (peer daemon) endpoints."""

    ws_host: str = "127.0.0.1"
    ws_port: int = 8781
    #: Origins allowed to open the browser WebSocket.
    ws_allowed_origins: tuple[str, ...] = ("http://localhost", "https://localhost")
    #: Refuse to bind a non-loopback ws_host unless explicitly allowed.
    insecure_bind: bool = False
    #: Fiber link: this daemon listens here (detector) or dials here (source).
    fiber_host: str = "127.0.0.1"
    fiber_port: int = 8791


@dataclass(frozen=True, slots=True)
class Intensities:
    """Decoy-state intensity classes — RESERVED, not implemented.

    Present so a future decoy extension changes emission scheduling, not the
    physics core (which already keeps multi-photon statistics exact). The
    plain BB84 emulation uses `signal` only.
    """

    enabled: bool = False
    signal: float = 0.5
    decoy: float = 0.1
    vacuum: float = 0.0


@dataclass(frozen=True, slots=True)
class BenchConfig:
    """Top-level daemon configuration."""

    #: 'source' owns the pulsed source; 'detector' owns the timetagger.
    role: str = "source"
    #: Deterministic seed fanned per emulation stage for reproducible tests.
    seed: int = 0
    source: SourceConfig = field(default_factory=SourceConfig)
    fiber: FiberConfig = field(default_factory=FiberConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    clock: ClockConfig = field(default_factory=ClockConfig)
    timing: TimingConfig = field(default_factory=TimingConfig)
    sync: SyncConfig = field(default_factory=SyncConfig)
    net: NetConfig = field(default_factory=NetConfig)
    intensities: Intensities = field(default_factory=Intensities)

    def slot_period_ps(self) -> int:
        """Pulse-slot period in picoseconds, from the rep rate."""
        return round(1e12 / self.timing.rep_rate_hz)

    def with_role(self, role: str) -> BenchConfig:
        """Return a copy with the role overridden (test convenience)."""
        return replace(self, role=role)


_VALID_ROLES = ("source", "detector")
_VALID_SYNC = ("shared-clock", "qubit")


def _section(raw: dict, key: str, cls: type):
    """Build a config dataclass from a raw TOML table, tuple-coercing lists."""
    data = raw.get(key, {})
    if not isinstance(data, dict):
        msg = f"[{key}] must be a table"
        raise ValueError(msg)  # noqa: TRY004 - config errors are uniformly ValueError
    fields = set(cls.__dataclass_fields__)
    unknown = set(data) - fields
    if unknown:
        msg = f"[{key}] has unknown keys: {sorted(unknown)}"
        raise ValueError(msg)
    coerced = {k: (tuple(v) if isinstance(v, list) else v) for k, v in data.items()}
    return cls(**coerced)


def load_config(path: str | Path) -> BenchConfig:
    """Load and validate a bench TOML config."""
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    return from_dict(raw)


def from_dict(raw: dict) -> BenchConfig:
    """Build (and validate) a BenchConfig from a parsed TOML mapping."""
    cfg = BenchConfig(
        role=raw.get("role", "source"),
        seed=raw.get("seed", 0),
        source=_section(raw, "source", SourceConfig),
        fiber=_section(raw, "fiber", FiberConfig),
        detector=_section(raw, "detector", DetectorConfig),
        clock=_section(raw, "clock", ClockConfig),
        timing=_section(raw, "timing", TimingConfig),
        sync=_section(raw, "sync", SyncConfig),
        net=_section(raw, "net", NetConfig),
        intensities=_section(raw, "intensities", Intensities),
    )
    _validate(cfg)
    return cfg


def _validate(cfg: BenchConfig) -> None:
    if cfg.role not in _VALID_ROLES:
        msg = f"role must be one of {_VALID_ROLES}, got {cfg.role!r}"
        raise ValueError(msg)
    if cfg.sync.mode not in _VALID_SYNC:
        msg = f"sync.mode must be one of {_VALID_SYNC}, got {cfg.sync.mode!r}"
        raise ValueError(msg)
    if cfg.source.mu <= 0:
        msg = "source.mu must be positive"
        raise ValueError(msg)
    if cfg.timing.slots_per_frame < cfg.sync.sync_slots:
        msg = "timing.slots_per_frame must be at least sync.sync_slots"
        raise ValueError(msg)
    if cfg.detector.gate_fraction <= 0 or cfg.detector.gate_fraction > 0.5:
        msg = "detector.gate_fraction must be in (0, 0.5]"
        raise ValueError(msg)
    if any(not o for o in cfg.net.ws_allowed_origins):
        msg = "net.ws_allowed_origins must not contain empty entries"
        raise ValueError(msg)
