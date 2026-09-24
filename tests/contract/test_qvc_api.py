"""Contract tests for the qvc signaling backend.

Pins the three shapes the cross-repo contract fixes: the ``/health`` liveness
body, the ``/api`` discovery manifest, and the error envelope on every 4xx/5xx
response. The envelope test is the one with history — ``/admin/events`` used to
hand back a bare string where the schema requires an object.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from _contract import assert_matches

from signaling.server import create_app

ADMIN_HEADERS = {"X-Admin-Secret": "test-admin-secret"}


@pytest.fixture
def client():
    flask_app, _sio, _rooms = create_app()
    return flask_app.test_client()


class TestContractSurface:
    def test_health_matches_the_schema(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        body = resp.get_json()
        assert_matches("health", body)
        assert body["service"] == "qvc"

    def test_discovery_manifest_matches_the_schema(self, client):
        resp = client.get("/api")
        assert resp.status_code == 200
        body = resp.get_json()
        assert_matches("manifest", body)
        assert body["service"] == "qvc"

    def test_manifest_lists_every_http_route(self, client):
        """The curl-able rule: every operation appears in the manifest."""
        flask_app, _sio, _rooms = create_app()
        listed = {(e["method"], e["path"]) for e in client.get("/api").get_json()["endpoints"]}
        actual = {
            (method, str(rule))
            for rule in flask_app.url_map.iter_rules()
            if rule.endpoint != "static"
            for method in (rule.methods or set()) - {"HEAD", "OPTIONS"}
        }
        assert actual - listed == set(), f"routes missing from /api: {sorted(actual - listed)}"

    def test_manifest_streaming_names_every_emitted_event(self, client):
        """Socket.IO events are not in the url-map, so _STREAMING lists them by
        hand — and must not fall behind what the server actually emits."""
        from signaling import server

        listed = {s["event"] for s in client.get("/api").get_json()["streaming"] if "event" in s}
        emitted = set()
        source = Path(server.__file__).read_text(encoding="utf-8")
        for line in source.splitlines():
            if "sio.emit(" in line:
                emitted.add(line.split('sio.emit("', 1)[1].split('"', 1)[0])
        assert emitted <= listed, f"emitted but undocumented: {sorted(emitted - listed)}"


class TestErrorEnvelope:
    def test_not_found_matches_the_schema(self, client):
        resp = client.get("/__contract_missing__")
        assert resp.status_code == 404
        body = resp.get_json()
        assert_matches("error", body)
        assert body["error"]["code"] == "not_found"

    def test_method_not_allowed_matches_the_schema(self, client):
        resp = client.post("/health")
        assert resp.status_code == 405
        assert_matches("error", resp.get_json())

    def test_bad_admin_events_limit_matches_the_schema(self, client):
        """The regression: this returned {"error": "<string>"}, which the schema
        rejects — `error` must be an object carrying `code` and `message`."""
        resp = client.get("/admin/events?limit=abc", headers=ADMIN_HEADERS)
        assert resp.status_code == 400
        body = resp.get_json()
        assert_matches("error", body)
        assert body["error"]["code"] == "bad_request"

    def test_fail_closed_admin_404_matches_the_schema(self, client, monkeypatch):
        """The admin guard shapes its refusal as a 404; that body is an error
        response too, so it must carry the envelope like any other."""
        monkeypatch.delenv("QVC_ADMIN_SECRET", raising=False)
        flask_app, _sio, _rooms = create_app()
        resp = flask_app.test_client().get("/admin/status")
        assert resp.status_code == 404
        assert_matches("error", resp.get_json())
