"""Security tests for the signaling server.

Covers the hardening added in the 2026-09 security round:
  - fail-closed admin auth (secret header, 404 when unset or wrong)
  - anchored CORS origin matching (localhostevil.com stays out)
  - per-IP rate limiting on connect/create/join
  - /admin/events limit validation
"""

import pytest

from signaling.server import _check_origin, create_app
from signaling.throttle import RateLimiter

ADMIN_HEADERS = {"X-Admin-Secret": "test-admin-secret"}


class FakePeer:
    """Minimal Socket.IO peer shim (see test_signaling_server.py)."""

    def __init__(self, sid, sio, environ=None):
        self.sid = sid
        self.sio = sio
        self.environ = environ or {}

    def connect(self):
        handler = self.sio.handlers.get("/", {}).get("connect")
        return handler(self.sid, self.environ) if handler else None

    def emit_event(self, event, data=None):
        handler = self.sio.handlers.get("/", {}).get(event)
        if handler:
            return handler(self.sid, data) if data is not None else handler(self.sid)
        return None


class TestAdminAuth:
    """The /admin surface is fail-closed behind X-Admin-Secret."""

    @pytest.mark.parametrize("path", ["/admin/status", "/admin/events", "/admin/rooms", "/admin/peers"])
    def test_no_header_is_404(self, path):
        flask_app, _, _ = create_app()
        assert flask_app.test_client().get(path).status_code == 404

    def test_wrong_secret_is_404(self):
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get(
            "/admin/status", headers={"X-Admin-Secret": "wrong"},
        )
        assert resp.status_code == 404

    def test_correct_secret_is_200(self):
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get("/admin/status", headers=ADMIN_HEADERS)
        assert resp.status_code == 200

    def test_unset_secret_disables_admin_entirely(self, monkeypatch):
        monkeypatch.delenv("QVC_ADMIN_SECRET", raising=False)
        flask_app, _, _ = create_app()
        # Even a formerly-valid header must not open the door: with no secret
        # configured there is nothing to compare against, so the surface is off.
        resp = flask_app.test_client().get("/admin/status", headers=ADMIN_HEADERS)
        assert resp.status_code == 404

    def test_health_and_api_stay_open(self):
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        assert client.get("/health").status_code == 200
        assert client.get("/api").status_code == 200


class TestEventsLimitValidation:
    """/admin/events?limit= is validated and clamped."""

    def test_non_integer_limit_is_400(self):
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get("/admin/events?limit=abc", headers=ADMIN_HEADERS)
        assert resp.status_code == 400

    def test_huge_limit_is_clamped(self):
        flask_app, _, rooms = create_app()
        for i in range(150):
            rooms.log_event("test_event", n=i)
        resp = flask_app.test_client().get("/admin/events?limit=999999", headers=ADMIN_HEADERS)
        assert resp.status_code == 200
        assert len(resp.get_json()["events"]) <= 100


class TestCORSAnchoring:
    """The localhost allowance must not match prefix-attack origins."""

    @pytest.mark.parametrize("origin", [
        "http://localhost",
        "http://localhost:3000",
        "https://localhost:8443",
        "http://127.0.0.1:5000",
        "https://andypeterson.dev",
    ])
    def test_allowed_origins(self, origin):
        assert _check_origin(origin)

    @pytest.mark.parametrize("origin", [
        "http://localhostevil.com",
        "http://localhost.evil.com",
        "https://andypeterson.dev.evil.com",
        "http://evil.com",
        "null",
    ])
    def test_rejected_origins(self, origin):
        assert not _check_origin(origin)

    def test_flask_rejects_evil_origin(self):
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get(
            "/health", headers={"Origin": "http://localhostevil.com"},
        )
        assert resp.headers.get("Access-Control-Allow-Origin") is None

    def test_flask_allows_localhost_origin(self):
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get(
            "/health", headers={"Origin": "http://localhost:3000"},
        )
        assert resp.headers.get("Access-Control-Allow-Origin") == "http://localhost:3000"


class TestRateLimiter:
    """Token-bucket unit behavior."""

    def test_allows_up_to_rate(self):
        limiter = RateLimiter(rate=3, per=60.0)
        assert [limiter.allow("ip")for _ in range(4)] == [True, True, True, False]

    def test_keys_are_independent(self):
        limiter = RateLimiter(rate=1, per=60.0)
        assert limiter.allow("a")
        assert not limiter.allow("a")
        assert limiter.allow("b")

    def test_refills_over_time(self):
        limiter = RateLimiter(rate=60, per=60.0)  # one token per second
        for _ in range(60):
            limiter.allow("ip")
        assert not limiter.allow("ip")
        # Simulate the passage of time by rewinding the stored timestamp.
        tokens, last = limiter._buckets["ip"]
        limiter._buckets["ip"] = (tokens, last - 2.0)
        assert limiter.allow("ip")


class TestServerThrottling:
    """The connect/create/join events enforce the per-IP limit."""

    def test_connect_rejected_over_limit(self, monkeypatch):
        monkeypatch.setenv("QVC_RATE_LIMIT", "2")
        _, sio, rooms = create_app()
        emitted = []
        sio.emit = lambda event, data=None, room=None, **kw: emitted.append(event)

        environ = {"REMOTE_ADDR": "10.0.0.1"}
        results = [FakePeer(f"sid{i}", sio, environ).connect() for i in range(3)]
        assert results[0] is not False
        assert results[1] is not False
        assert results[2] is False  # third connection from the same IP refused
        assert rooms.peer_count == 2

    def test_create_room_throttled(self, monkeypatch):
        monkeypatch.setenv("QVC_RATE_LIMIT", "3")
        _, sio, rooms = create_app()
        captured = []
        sio.emit = lambda event, data=None, room=None, **kw: captured.append(
            {"event": event, "data": data},
        )

        environ = {"REMOTE_ADDR": "10.0.0.2"}
        peer = FakePeer("sid1", sio, environ)
        peer.connect()  # costs 1 token
        peer.emit_event("create_room")  # 2nd token — succeeds
        assert rooms.room_count == 1
        rooms.leave_room("sid1")
        peer.emit_event("create_room")  # 3rd token — succeeds
        rooms.leave_room("sid1")
        peer.emit_event("create_room")  # over budget — throttled
        errors = [c for c in captured if c["event"] == "error"]
        assert any("Rate limit" in e["data"]["message"] for e in errors)
        assert rooms.room_count == 0

    def test_xff_first_hop_used_behind_proxy(self, monkeypatch):
        monkeypatch.setenv("QVC_RATE_LIMIT", "1")
        _, sio, rooms = create_app()
        sio.emit = lambda *a, **kw: None

        environ_a = {"HTTP_X_FORWARDED_FOR": "1.2.3.4", "REMOTE_ADDR": "10.0.0.9"}
        environ_b = {"HTTP_X_FORWARDED_FOR": "5.6.7.8", "REMOTE_ADDR": "10.0.0.9"}
        assert FakePeer("sid1", sio, environ_a).connect() is not False
        # Same proxy REMOTE_ADDR but a different client hop — its own bucket.
        assert FakePeer("sid2", sio, environ_b).connect() is not False
        assert FakePeer("sid3", sio, environ_a).connect() is False


class TestJoinErrorRedaction:
    """Join failures must not echo the attempted token back."""

    def test_join_error_omits_token(self):
        _, sio, _rooms = create_app()
        captured = []
        sio.emit = lambda event, data=None, room=None, **kw: captured.append(
            {"event": event, "data": data},
        )
        peer = FakePeer("sid1", sio)
        peer.connect()
        peer.emit_event("join_room", {"room_id": "SECRET-TOKEN-GUESS"})
        errors = [c for c in captured if c["event"] == "error"]
        assert len(errors) == 1
        assert "SECRET-TOKEN-GUESS" not in errors[0]["data"]["message"]
