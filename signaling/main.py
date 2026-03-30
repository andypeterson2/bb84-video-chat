"""Entry point for the signaling server."""

from __future__ import annotations

import logging
import os
import signal
import socket as _socket
import sys

from signaling.server import create_app


def _find_available_port(host: str = "127.0.0.1") -> int:
    """Bind to port 0 and let the OS assign an available port."""
    with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]

logging.basicConfig(
    level=logging.DEBUG if os.environ.get("QVC_DEBUG") else logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


def main() -> None:
    """Start the signaling server."""
    host = os.environ.get("QVC_HOST", "127.0.0.1")
    port = int(os.environ.get("QVC_SERVER_REST_PORT") or 0) or _find_available_port(host)

    flask_app, _sio, _rooms = create_app()

    def _shutdown(_sig=None, _frame=None):
        sig_name = signal.Signals(_sig).name if _sig else "manual"
        logger.info("Shutting down (%s)...", sig_name)
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    logger.info("Signaling server starting on %s:%d", host, port)

    import eventlet  # noqa: PLC0415
    import eventlet.wsgi  # noqa: PLC0415

    eventlet.wsgi.server(
        eventlet.listen((host, port)),
        flask_app.sio_wsgi_app,
        log_output=False,
    )


if __name__ == "__main__":
    main()
