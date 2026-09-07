"""Security tests for the signaling server.

Covers the hardening added in the 2026-09 security round:
  - fail-closed admin auth (secret header, 404 when unset or wrong)
  - anchored CORS origin matching (localhostevil.com stays out)
  - per-IP rate limiting on connect/create/join
  - /admin/events limit validation
"""

import pytest

from signaling.server import _check_origin, _parse_cors, create_app
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

    def test_non_ascii_header_is_404_not_500(self):
        """A non-ASCII secret header must not crash the comparison.

        hmac.compare_digest raises TypeError on non-ASCII str operands; an
        unhandled 500 there distinguishes 'admin enabled' (500) from
        'disabled' (404), the exact oracle the fail-closed 404 shaping denies.
        """
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get(
            "/admin/status", headers={"X-Admin-Secret": "\x80\xffnope"},
        )
        assert resp.status_code == 404

    def test_guard_404_matches_framework_404_shape(self):
        """The guard's 404 must be indistinguishable from a missing route."""
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        guarded = client.get("/admin/status", headers={"X-Admin-Secret": "wrong"})
        real = client.get("/no/such/route")
        assert guarded.status_code == real.status_code == 404
        assert guarded.get_json() == real.get_json()

    def test_wrong_secret_is_throttled_and_logged(self, monkeypatch, caplog):
        monkeypatch.setenv("QVC_RATE_LIMIT", "3")
        flask_app, sio, rooms = create_app()
        client = flask_app.test_client()
        import logging

        with caplog.at_level(logging.WARNING, logger="signaling.server"):
            for _ in range(4):
                client.get("/admin/status", headers={"X-Admin-Secret": "wrong"})
        assert any("wrong secret" in r.message for r in caplog.records)
        # The guesses drained the shared per-IP bucket: signaling actions from
        # the same address are now refused.
        emitted = []
        sio.emit = lambda *a, **kw: emitted.append(a)
        handler = sio.handlers["/"]["connect"]
        assert handler("sid-probe", {"REMOTE_ADDR": "127.0.0.1"}) is False

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

    def test_legacy_port_wildcard_translated_to_anchored_regex(self, caplog):
        """Old deployments may still set "http://localhost:*"; it must keep
        admitting any localhost port without re-opening the prefix-match hole."""
        import logging

        with caplog.at_level(logging.WARNING, logger="signaling.server"):
            entries, regexes, exact = _parse_cors("http://localhost:*,https://andypeterson.dev")
        assert any("legacy port wildcard" in r.message for r in caplog.records)
        assert exact == {"https://andypeterson.dev"}
        assert "http://localhost:*" not in entries  # nothing legacy survives
        assert any(rx.match("http://localhost:3000") for rx in regexes)
        assert any(rx.match("http://localhost") for rx in regexes)
        assert not any(rx.match("http://localhostevil.com") for rx in regexes)
        assert not any(rx.match("http://localhost:3000.evil.com") for rx in regexes)

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

    def test_check_origin_tolerates_the_engineio_call_shapes(self):
        # engineio may invoke the callback as (origin, environ) or (origin),
        # and passes origin=None when the request carries no Origin header —
        # matching a regex against None would raise, so it must be handled.
        assert _check_origin("http://localhost:3000", {"HTTP_ORIGIN": "x"})  # 2-arg
        assert _check_origin("http://localhost:3000")  # 1-arg
        assert not _check_origin(None)  # no Origin header
        assert not _check_origin("")
        assert not _check_origin("http://evil.com")

    @pytest.mark.parametrize(
        "headers",
        [
            {},  # no Origin header — the case that actually 500'd
            {"Origin": "http://localhost:3000"},  # allowed cross-origin
            {"Origin": "http://evil.com"},  # rejected cross-origin
        ],
    )
    def test_socketio_handshake_never_500s_on_the_origin_check(self, headers):
        """The Socket.IO handshake's CORS callback must never crash the server.

        Driving the Socket.IO WSGI app (not the Flask routes) exercises
        engineio's origin check; whatever the Origin header, the response is a
        normal engineio status — never a 500 from the callback raising.
        """
        from werkzeug.test import Client

        flask_app, _, _ = create_app()
        client = Client(flask_app.sio_wsgi_app)
        resp = client.get("/socket.io/?EIO=4&transport=polling", headers=headers)
        assert resp.status_code != 500


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

    def test_idle_buckets_swept_on_schedule(self):
        limiter = RateLimiter(rate=5, per=60.0)
        for i in range(100):
            limiter.allow(f"ip{i}")
        assert len(limiter._buckets) == 100
        # Age every bucket past the refill horizon and force the next sweep.
        limiter._buckets = {k: (t, last - 120.0) for k, (t, last) in limiter._buckets.items()}
        limiter._next_sweep = 0.0
        limiter.allow("fresh")
        assert set(limiter._buckets) == {"fresh"}

    def test_bucket_count_is_capped(self, monkeypatch):
        """A key-varying flood (e.g. spoofed XFF on a misconfigured deploy)
        must not grow memory without bound between sweeps."""
        monkeypatch.setattr("signaling.throttle._MAX_BUCKETS", 50)
        limiter = RateLimiter(rate=5, per=3600.0)
        for i in range(200):
            limiter.allow(f"ip{i}")
        assert len(limiter._buckets) <= 50


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

    def test_xff_ignored_by_default(self, monkeypatch):
        """Without QVC_TRUSTED_PROXIES, XFF is attacker-controlled — a spoofed
        per-request "client IP" must not mint a fresh rate-limit bucket."""
        monkeypatch.setenv("QVC_RATE_LIMIT", "1")
        _, sio, rooms = create_app()
        sio.emit = lambda *a, **kw: None

        environ_a = {"HTTP_X_FORWARDED_FOR": "1.2.3.4", "REMOTE_ADDR": "10.0.0.9"}
        environ_b = {"HTTP_X_FORWARDED_FOR": "5.6.7.8", "REMOTE_ADDR": "10.0.0.9"}
        assert FakePeer("sid1", sio, environ_a).connect() is not False
        # Different spoofed XFF, same real address: same bucket, throttled.
        assert FakePeer("sid2", sio, environ_b).connect() is False

    def test_xff_client_hop_used_behind_trusted_proxy(self, monkeypatch):
        monkeypatch.setenv("QVC_RATE_LIMIT", "1")
        monkeypatch.setenv("QVC_TRUSTED_PROXIES", "1")
        _, sio, rooms = create_app()
        sio.emit = lambda *a, **kw: None

        environ_a = {"HTTP_X_FORWARDED_FOR": "1.2.3.4", "REMOTE_ADDR": "10.0.0.9"}
        environ_b = {"HTTP_X_FORWARDED_FOR": "5.6.7.8", "REMOTE_ADDR": "10.0.0.9"}
        assert FakePeer("sid1", sio, environ_a).connect() is not False
        # Same proxy REMOTE_ADDR but a different client hop — its own bucket.
        assert FakePeer("sid2", sio, environ_b).connect() is not False
        assert FakePeer("sid3", sio, environ_a).connect() is False

    def test_xff_takes_nth_hop_from_right(self, monkeypatch):
        """Behind two proxies, only the second-from-right XFF entry is trusted;
        anything the client prepends to the chain is ignored."""
        from signaling.server import _client_ip

        monkeypatch.setenv("QVC_TRUSTED_PROXIES", "2")
        environ = {
            "HTTP_X_FORWARDED_FOR": "6.6.6.6, 1.2.3.4, 10.0.0.5",
            "REMOTE_ADDR": "10.0.0.9",
        }
        assert _client_ip(environ) == "1.2.3.4"
        # Chain shorter than the proxy count: something is misconfigured or
        # forged — fall back to the socket address.
        assert _client_ip({"HTTP_X_FORWARDED_FOR": "1.2.3.4", "REMOTE_ADDR": "10.0.0.9"}) == (
            "10.0.0.9"
        )


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


class TestLogRedaction:
    """Server logs must never contain a full room token or sid."""

    def test_lifecycle_logs_redact_identifiers(self, caplog):
        import logging

        _, sio, rooms = create_app()
        sio.emit = lambda *a, **kw: None
        peer = FakePeer("sid-abcdef123456", sio, {"REMOTE_ADDR": "10.1.1.1"})
        with caplog.at_level(logging.INFO, logger="signaling.server"):
            peer.connect()
            peer.emit_event("create_room")
            room = rooms.get_peer_room("sid-abcdef123456")
            assert room is not None  # sanity: the room really exists
            room_id = room.room_id
            handler = sio.handlers["/"]["disconnect"]
            handler("sid-abcdef123456")
        joined = " ".join(r.getMessage() for r in caplog.records)
        assert joined  # sanity: the lifecycle actually logged something
        assert "sid-abcdef123456" not in joined
        assert room_id not in joined
