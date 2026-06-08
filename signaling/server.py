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

import logging
import os
import re

import socketio
from flask import Flask, jsonify
from flask import request as flask_req
from flask_cors import CORS

from signaling.errors import register_error_handlers
from signaling.rooms import RoomManager

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
    {"protocol": "webrtc", "description": "Encrypted media + BB84/QKD run peer-to-peer in the browser; not brokered by this server."},
]


def _version() -> str:
    """Service version (overridable via QVC_VERSION at deploy time)."""
    return os.environ.get("QVC_VERSION", "0.1.0")

# CORS: accept any localhost origin + production domain
_CORS_RAW = os.environ.get(
    "QVC_CORS_ORIGINS",
    "http://localhost:*,https://localhost:*,https://andypeterson.dev",
)
_CORS_LIST = [o.strip() for o in _CORS_RAW.split(",")]
_LOCALHOST_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")
_EXTRA_ORIGINS = {o for o in _CORS_LIST if not o.endswith(":*")}


def _check_origin(origin: str) -> bool:
    """Check if an origin is allowed (any localhost port + explicit origins)."""
    return _LOCALHOST_RE.match(origin) is not None or origin in _EXTRA_ORIGINS


def create_app() -> tuple[Flask, socketio.Server, RoomManager]:  # noqa: C901, PLR0915
    """Create and configure the signaling server.

    Returns:
        Tuple of (flask_app, socketio_server, room_manager).
    """
    flask_app = Flask(__name__)
    CORS(flask_app, origins=_CORS_LIST)

    # Use eventlet in production (Docker), threading for tests/local dev
    _async_mode = os.environ.get("SIO_ASYNC_MODE", "threading")
    sio = socketio.Server(
        cors_allowed_origins=_check_origin,
        async_mode=_async_mode,
        logger=False,
        engineio_logger=False,
    )
    wsgi_app = socketio.WSGIApp(sio, flask_app)
    # Attach as a separate attribute (not flask_app.wsgi_app to avoid recursion)
    flask_app.sio_wsgi_app = wsgi_app

    rooms = RoomManager()

    # ── REST endpoints ──────────────────────────────────────────────

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
        limit = int(flask_req.args.get("limit", 20))
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
    def connect(sid, _environ):
        """Handle new peer connection."""
        rooms.register_peer(sid)
        rooms.log_event("peer_connected", sid=sid)
        logger.info("Peer connected: %s (total: %d)", sid, rooms.peer_count)
        sio.emit("welcome", {"sid": sid}, room=sid)

    @sio.event
    def disconnect(sid):
        """Handle peer disconnection — notify room partner."""
        room = rooms.get_peer_room(sid)
        other_sid = room.other_peer(sid) if room else None
        room_id = rooms.unregister_peer(sid)
        rooms.log_event("peer_disconnected", sid=sid, room_id=room_id)
        if other_sid:
            sio.emit("peer-disconnected", {"room_id": room_id}, room=other_sid)
        logger.info("Peer disconnected: %s (total: %d)", sid, rooms.peer_count)

    @sio.event
    def create_room(sid):
        """Create a new room. Emitter becomes the first peer."""
        room = rooms.create_room(sid)
        if room is None:
            sio.emit("error", {"message": "Cannot create room"}, room=sid)
            return
        rooms.log_event("room_created", sid=sid, room_id=room.room_id)
        logger.info("Room created: %s by %s", room.room_id, sid)
        sio.emit("room-created", {"room_id": room.room_id}, room=sid)

    @sio.event
    def join_room(sid, data):
        """Join an existing room by room_id."""
        room_id = data.get("room_id", "") if isinstance(data, dict) else str(data)
        room = rooms.join_room(sid, room_id)
        if room is None:
            sio.emit("error", {"message": f"Cannot join room {room_id}"}, room=sid)
            return
        other_sid = room.other_peer(sid)
        rooms.log_event("peer_joined", sid=sid, room_id=room_id)
        logger.info("Peer %s joined room %s", sid, room_id)
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
        logger.info("Peer %s left room %s", sid, room_id)

    @sio.event
    def offer(sid, data):
        """Relay SDP offer to the other peer in the room."""
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("offer", {"sdp": data.get("sdp"), "from": sid}, room=other_sid)

    @sio.event
    def answer(sid, data):
        """Relay SDP answer to the other peer in the room."""
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("answer", {"sdp": data.get("sdp"), "from": sid}, room=other_sid)

    @sio.event
    def ice_candidate(sid, data):
        """Relay ICE candidate to the other peer in the room."""
        room = rooms.get_peer_room(sid)
        if room is None:
            return
        other_sid = room.other_peer(sid)
        if other_sid:
            sio.emit("ice-candidate", {
                "candidate": data.get("candidate"),
                "from": sid,
            }, room=other_sid)

    register_error_handlers(flask_app)

    return flask_app, sio, rooms
