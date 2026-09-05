"""Root conftest.py -- sets up sys.path so signaling imports work."""

import os
import sys
from pathlib import Path

os.environ.setdefault("QVC_DEVELOPMENT", "true")
# The admin surface is fail-closed (404 without a configured secret); give the
# test suite a secret so admin endpoints are exercisable. Tests that verify the
# fail-closed behavior remove it with monkeypatch.
os.environ.setdefault("QVC_ADMIN_SECRET", "test-admin-secret")

_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
