"""Root conftest.py -- sets up sys.path so signaling imports work."""

import os
import sys
from pathlib import Path

os.environ.setdefault("QVC_DEVELOPMENT", "true")
# Admin endpoints 404 without a secret; tests of that fail-closed behavior
# remove this one with monkeypatch.
os.environ.setdefault("QVC_ADMIN_SECRET", "test-admin-secret")

_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
