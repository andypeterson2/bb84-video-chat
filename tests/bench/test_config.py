"""Config loading and validation."""

import pytest

from bench.config import BenchConfig, from_dict, load_config


def test_defaults_are_sane():
    cfg = BenchConfig()
    assert cfg.role == "source"
    assert cfg.slot_period_ps() == 10000  # 100 MHz
    assert 0 < cfg.fiber.transmittance() < 1


def test_from_dict_round_trips_sections():
    raw = {
        "role": "detector",
        "seed": 5,
        "source": {"mu": 0.2},
        "timing": {"rep_rate_hz": 50e6, "slots_per_frame": 4096},
        "net": {"ws_allowed_origins": ["https://andypeterson.dev"]},
    }
    cfg = from_dict(raw)
    assert cfg.role == "detector"
    assert cfg.source.mu == 0.2
    assert cfg.slot_period_ps() == 20000
    assert cfg.net.ws_allowed_origins == ("https://andypeterson.dev",)


def test_unknown_key_is_rejected():
    with pytest.raises(ValueError, match="unknown keys"):
        from_dict({"source": {"typo": 1}})


@pytest.mark.parametrize(
    ("raw", "match"),
    [
        ({"role": "middle"}, "role must be"),
        ({"sync": {"mode": "gps"}}, "sync.mode"),
        ({"source": {"mu": 0}}, "mu must be positive"),
        ({"detector": {"gate_fraction": 0.9}}, "gate_fraction"),
        ({"sync": {"sync_slots": 999999}, "timing": {"slots_per_frame": 1000}}, "slots_per_frame"),
    ],
)
def test_validation_rejects_bad_configs(raw, match):
    with pytest.raises(ValueError, match=match):
        from_dict(raw)


def test_loads_the_shipped_example(tmp_path):
    from pathlib import Path

    example = Path(__file__).resolve().parents[2] / "bench" / "bench.toml.example"
    cfg = load_config(example)
    assert cfg.role == "source"
    assert cfg.timing.slots_per_frame == 100000
