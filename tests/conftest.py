"""Root conftest.py -- sets up sys.path so signaling imports work."""

import os
import sys
from pathlib import Path

os.environ.setdefault("QVC_DEVELOPMENT", "true")

_ROOT = str(Path(__file__).resolve().parent.parent)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
