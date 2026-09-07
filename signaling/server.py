"""Signaling server: Flask + Socket.IO for WebRTC connection establishment.

Responsibilities:
  - Relay SDP offers/answers between peers
  - Relay ICE candidates between peers
  - Manage rooms (create, join, leave)
  - Provide admin status endpoint

Non-responsibilities:
  - Media transport (handled by WebRTC peer-to-peer)
  - Encryption (handled by browser Insertable Streams)
  - Key exchange (handled by RTCDataChannel + BB84)
"""

from __future__ import annotations

import hmac
import logging
import os
import re

import socketio
from flask import Flask, jsonify
from flask import request as flask_req
from flask_cors import CORS
from werkzeug.exceptions import NotFound

from signaling.errors import register_error_handlers, respond_error
from signaling.rooms import RoomManager, redact
from signaling.throttle import RateLimiter
from signaling.turn import ice_servers

logger = logging.getLogger(__name__)

SERVICE = "qvc"

# Streaming channels are not in the HTTP url-map; list them by hand. The
# encrypted media + BB84/QKD path runs peer-to-peer in the browser and is
# the explicit live-only layer (exempt from the curl-able rule).
_STREAMING = [
    {"protocol": "socket.io", "event": "offer", "description": "Relay SDP offer to the room peer."},
    {"protocol": "socket.io", "event": "answer", "description": "Relay SDP answer to the room peer."},
    {"protocol": "socket.io", "event": "ice-candidate", "description": "Relay ICE candidate to the room peer."},
    {"protocol": "socket.io", "event": "room-created", "description": "Room-creation result."},
    {"protocol": "socket.io", "event": "room-joined", "description": "Room-join result (both peers)."},
    {"protocol": "socket.io", "event": "peer-disconnected", "description": "Peer left/disconnected notification."},
    {
        "protocol": "webrtc",
        "description": "Encrypted media + BB84/QKD run peer-to-peer in the browser; not brokered by this server.",
    },
]


def _version() -> str:
    """Service version (overridable via QVC_VERSION at deploy time)."""
    return os.environ.get("QVC_VERSION", "0.1.0")

# CORS: any localhost port + the production domain. The localhost entry is a
# FULLY ANCHORED regex on purpose — flask-cors matches regex entries with
# re.match (start-anchored only), so the old wildcard "http://localhost:*"
# also admitted origins like http://localhostevil.com.
_CORS_RAW = os.environ.get(
    "QVC_CORS_ORIGINS",
    r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$,https://andypeterson.dev",
)
# Deployments configured before the anchoring fix may still carry the legacy
# port-wildcard form ("http://<host>:*"). Left as-is it would be matched
# EXACTLY (never true for a real Origin header), silently locking those
# deployments out — so translate it to the anchored any-port regex instead.
_LEGACY_WILDCARD = re.compile(r"(https?)://([A-Za-z0-9.\-]+):\*")


def _parse_cors(raw: str) -> tuple[list[str], list[re.Pattern], set[str]]:
    """Split QVC_CORS_ORIGINS into (all entries, regex entries, exact entries)."""
    entries = []
    for item in raw.split(","):
        entry = item.strip()
        if not entry:
            continue
        legacy = _LEGACY_WILDCARD.fullmatch(entry)
        if legacy:
            scheme, host = legacy.groups()
            entry = rf"^{scheme}://{re.escape(host)}(:\d+)?$"
            logger.warning(
                "QVC_CORS_ORIGINS entry %r uses the legacy port wildcard; "
                "matching it as the anchored regex %r instead",
                item.strip(),
                entry,
            )
        entries.append(entry)
    # Entries starting with '^' are regexes (flask-cors treats them the same
    # way); everything else is matched exactly.
    regexes = [re.compile(o) for o in entries if o.startswith("^")]
    exact = {o for o in entries if not o.startswith("^")}
    return entries, regexes, exact


_CORS_LIST, _CORS_REGEXES, _EXTRA_ORIGINS = _parse_cors(_CORS_RAW)


def _check_origin(origin: str | None = None, environ: dict | None = None) -> bool:
    """Origin check for Socket.IO (which needs a callable, not patterns).

    Two robustness points, both of which engineio can otherwise turn into an
    opaque 500 on the handshake:
      - Arity: engineio invokes this as ``(origin, environ)`` on newer
        versions and ``(origin)`` on older ones; the optional second argument
        accepts both.
      - No Origin header: a same-origin or non-browser request has
        ``origin=None``, and matching a regex against ``None`` would raise. A
        request with no cross-origin to vet is simply not allow-listed.
    """
    del environ  # the allowlist decision is origin-only
    if not origin:
        return False
    return origin in _EXTRA_ORIGINS or any(rx.match(origin) for rx in _CORS_REGEXES)


def _trusted_proxy_count() -> int:
    """QVC_TRUSTED_PROXIES: reverse proxies in front of this server (default 0)."""
    try:
        return max(0, int(os.environ.get("QVC_TRUSTED_PROXIES", "0")))
    except ValueError:
        return 0


def _client_ip(environ: dict) -> str:
    """Client IP for rate limiting; trusts XFF only behind trusted proxies.

    X-Forwarded-For is client-controlled up to the first trusted hop: honoring
    it unconditionally lets anyone spoof a fresh "IP" per request and sidestep
    rate limiting entirely. With QVC_TRUSTED_PROXIES=0 (the default) the header
    is ignored; behind N proxies, the address N hops from the right of the XFF
    chain is the first one a proxy actually vouched for.
    """
    trusted = _trusted_proxy_count()
    if trusted > 0:
        forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
        hops = [h.strip() for h in forwarded.split(",") if h.strip()]
        if len(hops) >= trusted:
            return hops[-trusted]
    return environ.get("REMOTE_ADDR", "unknown")


def create_app() -> tuple[Flask, socketio.Server, RoomManager]:  # noqa: C901, PLR0915
    """Create and configure the signaling server.

    Returns:
        Tuple of (flask_app, socketio_server, room_manager).
    """
    flask_app = Flask(__name__)
    CORS(flask_app, origins=_CORS_LIST)

    # Use eventlet in production (Docker), threading for tests/local dev.
    # main.py forces eventlet for the real server (and monkey-patches the
    # stdlib) so the async model matches the WSGI server it runs under.
    _async_mode = os.environ.get("SIO_ASYNC_MODE", "threading")
    # Cap inbound frames so an oversize payload can't exhaust memory. Signaling
    # messages are small (an SDP offer is the largest, a few KB); 64 KiB is
    # generous headroom. Overridable for unusual SDP.
    _max_buffer = int(os.environ.get("QVC_MAX_HTTP_BUFFER", str(64 * 1024)))
    sio = socketio.Server(
        cors_allowed_origins=_check_origin,
        async_mode=_async_mode,
        max_http_buffer_size=_max_buffer,
        logger=False,
        engineio_logger=False,
    )
    wsgi_app = socketio.WSGIApp(sio, flask_app)
    # Attach as a separate attribute (not flask_app.wsgi_app to avoid recursion)
    flask_app.sio_wsgi_app = wsgi_app

    rooms = RoomManager()

    # Per-IP token bucket covering connect/create/join — the abuse surface.
    # SDP/ICE relay is not throttled: it is only reachable once paired.
    limiter = RateLimiter(
        rate=int(os.environ.get("QVC_RATE_LIMIT", "30")),
        per=float(os.environ.get("QVC_RATE_WINDOW", "60")),
    )
    sid_ips: dict[str, str] = {}

    # ── REST endpoints ──────────────────────────────────────────────

    # Admin surface is fail-closed: without QVC_ADMIN_SECRET in the environment
    # it does not exist (404, indistinguishable from no such route), and with it
    # every /admin request must present the secret in X-Admin-Secret.
    admin_secret = os.environ.get("QVC_ADMIN_SECRET", "")

    @flask_app.before_request
    def _admin_guard():
        if not flask_req.path.startswith("/admin"):
            return None
        supplied = flask_req.headers.get("X-Admin-Secret", "")
        # Compare as bytes: hmac.compare_digest raises TypeError on non-ASCII
        # str operands, and an unhandled 500 there would distinguish "admin
        # enabled" from the 404 returned when it is disabled — the exact oracle
        # the fail-closed 404 shaping exists to deny.
        if not admin_secret or not hmac.compare_digest(
            supplied.encode("utf-8", "surrogatepass"), admin_secret.encode("utf-8", "surrogatepass"),
        ):
            if admin_secret and supplied:
                # A wrong guess is an active probe: burn a token from the same
                # per-IP bucket as signaling abuse, and leave a trace.
                ip = _client_ip(flask_req.environ)
                limiter.allow(ip)
                logger.warning("Rejected /admin request with wrong secret from %s", ip)
            # Shape-identical to a framework 404 so the guard does not reveal
            # that the /admin surface exists at all.
            return respond_error("not_found", NotFound.description, 404)
        return None

    @flask_app.route("/admin/status")
    def admin_status():
        """Return server health and stats."""
        return jsonify({
            "status": "ok",
            "uptime_seconds": rooms.uptime_seconds,
            "rooms": rooms.room_count,
            "peers": rooms.peer_count,
        })

    @flask_app.route("/admin/events")
    def admin_events():
        """Return recent events for the dashboard."""
        try:
            limit = int(flask_req.args.get("limit", "20"))
        except ValueError:
            return jsonify({"error": "limit must be an integer"}), 400
        limit = max(1, min(limit, 100))
        return jsonify({"events": rooms.get_events(limit)})

    @flask_app.route("/admin/rooms")
    def admin_rooms():
        """Return active rooms for the dashboard."""
        return jsonify({"rooms": rooms.get_rooms_summary()})

    @flask_app.route("/admin/peers")
    def admin_peers():
        """Return connected peers for the dashboard."""
        return jsonify({"peers": rooms.get_peers_summary()})

    # ── Contract routes: health + discovery ─────────────────────────

    @flask_app.get("/health")
    def health():
        """Liveness probe for the qvc signaling backend."""
        return jsonify({
            "status": "ok",
            "service": SERVICE,
            "version": _version(),
            "uptime_s": round(rooms.uptime_seconds, 1),
        })

    @flask_app.get("/ice-servers")
    def ice_servers_route():
        """WebRTC ICE servers: STUN, plus short-lived TURN credentials if configured."""
        return jsonify({"iceServers": ice_servers()})

    @flask_app.get("/api")
    def api_index():
        """Discovery index: HTTP endpoints plus signaling/streaming channels."""
        seen: set[tuple[str, str]] = set()
        endpoints = []
        for rule in flask_app.url_map.iter_rules():
            if rule.endpoint == "static":
                continue
            path = str(rule)
            view = flask_app.view_functions.get(rule.endpoint)
            summary = ((getattr(view, "__doc__", "") or "").strip().splitlines() or [""])[0].strip()
            for method in (rule.methods or set()) - {"HEAD", "OPTIONS"}:
                if (method, path) in seen:
                    continue
                seen.add((method, path))
                endpoints.append({"method": method, "path": path, "summary": summary})
        endpoints.sort(key=lambda e: (e["path"], e["method"]))
        return jsonify({
            "service": SERVICE,
            "version": _version(),
            "endpoints": endpoints,
            "streaming": _STREAMING,
        })

    # ── Socket.IO events ────────────────────────────────────────────

    @sio.event
    def connect(sid, environ):
        """Handle new peer connection (rejected outright when over the rate cap)."""
        ip = _client_ip(environ)
        if not limiter.allow(ip):
            logger.warning("Connection rate limit exceeded")
            return False
        sid_ips[sid] = ip
        rooms.register_peer(sid)
        rooms.log_event("peer_connected", sid=sid)
        logger.info("Peer connected: %s (total: %d)", redact(sid), rooms.peer_count)
        sio.emit("welcome", {"sid": sid}, room=sid)
        return True

    @sio.event
    def disconnect(sid):
        """Handle peer disconnection — notify room partner."""
        sid_ips.pop(sid, None)
        room = rooms.get_peer_room(sid)
        other_sid = room.other_peer(sid) if room else None
        room_id = rooms.unregister_peer(sid)
        rooms.log_event("peer_disconnected", sid=sid, room_id=room_id)
        if other_sid:
            sio.emit("peer-disconnected", {"room_id": room_id}, room=other_sid)
        logger.info("Peer disconnected: %s (total: %d)", redact(sid), rooms.peer_count)

    @sio.event
    def create_room(sid):
        """Create a new room. Emitter becomes the first peer."""
        if not limiter.allow(sid_ips.get(sid, "unknown")):
            sio.emit("error", {"message": "Rate limit exceeded — slow down"}, room=sid)
            return
        room = rooms.create_room(sid)
        if room is None:
            sio.emit("error", {"message": "Cannot create room"}, room=sid)
            return
        rooms.log_event("room_created", sid=sid, room_id=room.room_id)
        logger.info("Room created: %s by %s", redact(room.room_id), redact(sid))
        sio.emit("room-created", {"room_id": room.room_id}, room=sid)

    @sio.event
    def join_room(sid, data):
        """Join an existing room by its capability token."""
        if not limiter.allow(sid_ips.get(sid, "unknown")):
            sio.emit("error", {"message": "Rate limit exceeded — slow down"}, room=sid)
            return
        room_id = data.get("room_id", "") if isinstance(data, dict) else str(data)
        room = rooms.join_room(sid, room_id)
        if room is None:
            # Deliberately does not echo the attempted token back.
            sio.emit("error", {"message": "Cannot join room"}, room=sid)
            return
        other_sid = room.other_peer(sid)
        rooms.log_event("peer_joined", sid=sid, room_id=room_id)
        logger.info("Peer %s joined room %s", redact(sid), redact(room_id))
        # Notify both peers
        sio.emit("room-joined", {"room_id": room_id, "initiator": True}, room=other_sid)
        sio.emit("room-joined", {"room_id": room_id, "initiator": False}, room=sid)

    @sio.event
    def leave_room(sid):
        """Leave the current room."""
        room = rooms.get_peer_room(sid)
        other_sid = room.other_peer(sid) if room else None
        room_id = rooms.leave_room(sid)
        rooms.log_event("peer_left", sid=sid, room_id=room_id)
        if room_id and other_sid:
            sio.emit("peer-disconnected", {"room_id": room_id}, room=other_sid)
        logger.info("Peer %s left room %s", redact(sid), redact(room_id))

    @sio.event
    def offer(sid, data):
        """Relay SDP offer to the other peer in the room."""
        if not isinstance(data, dict):
            return
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("offer", {"sdp": data.get("sdp"), "from": sid}, room=other_sid)

    @sio.event
    def answer(sid, data):
        """Relay SDP answer to the other peer in the room."""
        if not isinstance(data, dict):
            return
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("answer", {"sdp": data.get("sdp"), "from": sid}, room=other_sid)

    @sio.event
    def ice_candidate(sid, data):
        """Relay ICE candidate to the other peer in the room."""
        if not isinstance(data, dict):
            return
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("ice-candidate", {
                "candidate": data.get("candidate"),
                "from": sid,
            }, room=other_sid)

    @sio.event
    def request_ice_restart(sid):
        """Relay an ICE-restart request to the room peer (answerer → initiator)."""
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("request-ice-restart", {}, room=other_sid)

    @sio.event
    def eve_demo(sid, data):
        """Relay the eavesdropper-demo on/off state to the room peer.

        The joiner has no toggle, so this tells them the QBER spike is a demo
        the other side triggered, not a real attack.
        """
        if not isinstance(data, dict):
            return
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("eve-demo", {"active": bool(data.get("active"))}, room=other_sid)

    register_error_handlers(flask_app)

    return flask_app, sio, rooms
