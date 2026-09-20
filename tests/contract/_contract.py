"""Shared helpers for the API contract tests.

Validates responses against the JSON Schemas in ``schemas/``, vendored from the
website repo's ``docs/api-contract/schemas/``. The schemas are the cross-repo
agreement every backend keeps: ``/health`` liveness, the ``/api`` discovery
manifest, and the 4xx/5xx error envelope.

Unlike the sibling services, qvc's signaling app is importable here, so these
tests drive it through Flask's test client instead of a live socket. They run on
every CI push rather than skipping when nothing is listening, which is the point
— a response that stops matching the schema should fail the build.

Requires ``jsonschema``; the suite skips entirely if it is not installed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("jsonschema", reason="contract tests require jsonschema")
from jsonschema import Draft202012Validator

_SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"
_VALIDATORS: dict[str, Draft202012Validator] = {}


def _validator(name: str) -> Draft202012Validator:
    if name not in _VALIDATORS:
        schema = json.loads((_SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
        _VALIDATORS[name] = Draft202012Validator(schema)
    return _VALIDATORS[name]


def assert_matches(schema_name: str, instance: Any) -> None:
    """Assert *instance* validates against ``schemas/<schema_name>.schema.json``."""
    errors = sorted(_validator(schema_name).iter_errors(instance), key=str)
    assert not errors, (
        f"{schema_name} schema violation: {errors[0].message}\n"
        f"instance: {json.dumps(instance)[:400]}"
    )
