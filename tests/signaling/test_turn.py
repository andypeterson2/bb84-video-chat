"""Tests for ephemeral TURN credential minting and the /ice-servers route."""

import base64
import hashlib
import hmac

from signaling.server import create_app
from signaling.turn import ice_servers, turn_credential

SECRET = "shared-turn-secret"
URLS = ["turn:relay.example.com:3478?transport=udp", "turns:relay.example.com:5349"]


def _expected_credential(username: str, secret: str) -> str:
    mac = hmac.new(secret.encode(), username.encode(), hashlib.sha1)
    return base64.b64encode(mac.digest()).decode()


class TestTurnCredential:
    def test_username_carries_future_expiry_and_nonce(self):
        cred = turn_credential(SECRET, URLS, ttl=3600, now=1_000_000)
        ts, _, nonce = cred["username"].partition(":")
        assert int(ts) == 1_000_000 + 3600
        assert nonce  # a non-empty random nonce

    def test_credential_is_the_hmac_coturn_recomputes(self):
        cred = turn_credential(SECRET, URLS, ttl=600, now=42)
        assert cred["credential"] == _expected_credential(cred["username"], SECRET)
        assert cred["urls"] == URLS

    def test_a_wrong_secret_would_not_validate(self):
        cred = turn_credential(SECRET, URLS, ttl=600, now=42)
        assert cred["credential"] != _expected_credential(cred["username"], "other-secret")


class TestIceServers:
    def test_stun_only_when_turn_unconfigured(self, monkeypatch):
        monkeypatch.delenv("QVC_TURN_SECRET", raising=False)
        monkeypatch.delenv("QVC_TURN_URLS", raising=False)
        servers = ice_servers()
        assert all("username" not in s for s in servers)
        assert any("stun:" in u for s in servers for u in _urls(s))

    def test_turn_appended_when_configured(self, monkeypatch):
        monkeypatch.setenv("QVC_TURN_SECRET", SECRET)
        monkeypatch.setenv("QVC_TURN_URLS", ",".join(URLS))
        servers = ice_servers(now=100)
        turn = [s for s in servers if "username" in s]
        assert len(turn) == 1
        assert turn[0]["credential"] == _expected_credential(turn[0]["username"], SECRET)

    def test_ttl_env_is_honored(self, monkeypatch):
        monkeypatch.setenv("QVC_TURN_SECRET", SECRET)
        monkeypatch.setenv("QVC_TURN_URLS", URLS[0])
        monkeypatch.setenv("QVC_TURN_TTL", "120")
        servers = ice_servers(now=0)
        turn = next(s for s in servers if "username" in s)
        assert int(turn["username"].split(":")[0]) == 120

    def test_invalid_ttl_falls_back(self, monkeypatch):
        monkeypatch.setenv("QVC_TURN_SECRET", SECRET)
        monkeypatch.setenv("QVC_TURN_URLS", URLS[0])
        monkeypatch.setenv("QVC_TURN_TTL", "not-a-number")
        servers = ice_servers(now=0)
        turn = next(s for s in servers if "username" in s)
        assert int(turn["username"].split(":")[0]) == 3600  # default

    def test_custom_stun_urls(self, monkeypatch):
        monkeypatch.delenv("QVC_TURN_SECRET", raising=False)
        monkeypatch.setenv("QVC_STUN_URLS", "stun:stun.example.org:3478")
        servers = ice_servers()
        assert servers == [{"urls": ["stun:stun.example.org:3478"]}]

    def test_secret_is_never_in_the_response(self, monkeypatch):
        monkeypatch.setenv("QVC_TURN_SECRET", SECRET)
        monkeypatch.setenv("QVC_TURN_URLS", ",".join(URLS))
        servers = ice_servers(now=1)
        assert SECRET not in repr(servers)


class TestIceServersRoute:
    def test_route_returns_stun_only_by_default(self, monkeypatch):
        monkeypatch.delenv("QVC_TURN_SECRET", raising=False)
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get("/ice-servers")
        assert resp.status_code == 200
        servers = resp.get_json()["iceServers"]
        assert servers
        assert all("username" not in s for s in servers)

    def test_route_includes_turn_when_configured(self, monkeypatch):
        monkeypatch.setenv("QVC_TURN_SECRET", SECRET)
        monkeypatch.setenv("QVC_TURN_URLS", ",".join(URLS))
        flask_app, _, _ = create_app()
        resp = flask_app.test_client().get("/ice-servers")
        servers = resp.get_json()["iceServers"]
        turn = [s for s in servers if "username" in s]
        assert len(turn) == 1
        assert SECRET not in resp.get_data(as_text=True)


def _urls(server: dict) -> list[str]:
    u = server.get("urls", [])
    return u if isinstance(u, list) else [u]
