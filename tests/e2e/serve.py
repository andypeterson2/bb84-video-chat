"""Combined signaling + static-client server for e2e tests.

Serves the Socket.IO signaling app AND the browser client from one origin
(http://localhost:<port>), so Playwright can drive two browser contexts
through a real call. Uses eventlet (as production does) for reliable
WebSocket upgrades — werkzeug's dev server does not carry Socket.IO's
websocket transport dependably.
"""

from __future__ import annotations

import eventlet

eventlet.monkey_patch()  # must run before other imports pull in socket/ssl

import os  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
os.environ["SIO_ASYNC_MODE"] = "eventlet"
os.environ.setdefault("QVC_DEVELOPMENT", "true")

from flask import send_from_directory  # noqa: E402

from signaling.server import create_app  # noqa: E402

flask_app, sio, rooms = create_app()
CLIENT = ROOT / "website" / "client"

# Flask's built-in /static route points at a nonexistent server-side dir and
# shadows any catch-all, so repoint it at the client's static assets.
flask_app.static_folder = str(CLIENT / "static")


@flask_app.route("/")
def _index():
    return send_from_directory(CLIENT, "index.html")


@flask_app.route("/<path:path>")
def _client_files(path):
    return send_from_directory(CLIENT, path)


if __name__ == "__main__":
    import eventlet.wsgi

    port = int(os.environ.get("QVC_E2E_PORT", "8077"))
    eventlet.wsgi.server(eventlet.listen(("127.0.0.1", port)), flask_app.sio_wsgi_app, log_output=False)
