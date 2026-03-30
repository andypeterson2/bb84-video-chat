"""Integration tests for the signaling server.

Tests the full Socket.IO event flow: connect, create/join rooms,
SDP relay, ICE relay, disconnect notification.

Uses a thin wrapper around the Socket.IO server to simulate peers
and capture emitted events without needing real WebSocket connections.
"""

import pytest

from signaling.server import create_app


class FakePeer:
    """Simulates a connected Socket.IO peer for testing.

    Registers event handlers on the sio server, then invokes them
    via the server's internal _trigger_event to simulate client behavior.
    """

    def __init__(self, sid, sio, captured):
        self.sid = sid
        self.sio = sio
        self.captured = captured

    def connect(self):
        """Simulate a peer connecting."""
        # Manually call the registered connect handler
        handler = self.sio.handlers.get("/", {}).get("connect")
        if handler:
            handler(self.sid, {})

    def disconnect(self):
        """Simulate a peer disconnecting."""
        handler = self.sio.handlers.get("/", {}).get("disconnect")
        if handler:
            handler(self.sid)

    def emit_event(self, event, data=None):
        """Simulate the peer emitting an event to the server."""
        handler = self.sio.handlers.get("/", {}).get(event)
        if handler:
            if data is not None:
                handler(self.sid, data)
            else:
                handler(self.sid)


@pytest.fixture
def env():
    """Set up signaling server with event capture."""
    flask_app, sio, rooms = create_app()

    captured = []

    def tracking_emit(event, data=None, room=None, **kwargs):
        captured.append({"event": event, "data": data, "room": room})

    sio.emit = tracking_emit

    def make_peer(sid):
        peer = FakePeer(sid, sio, captured)
        peer.connect()
        return peer

    return {
        "flask_app": flask_app,
        "sio": sio,
        "rooms": rooms,
        "captured": captured,
        "make_peer": make_peer,
    }


def events_of(captured, event_name):
    """Filter captured events by name."""
    return [e for e in captured if e["event"] == event_name]


class TestAdminEndpoint:
    """REST /admin/status endpoint."""

    def test_status_returns_ok(self):
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        resp = client.get("/admin/status")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "ok"
        assert data["rooms"] == 0
        assert data["peers"] == 0


class TestSignalingFlow:
    """Socket.IO signaling event integration tests."""

    def test_connect_sends_welcome(self, env):
        env["make_peer"]("sid1")
        assert env["rooms"].peer_count == 1
        welcomes = events_of(env["captured"], "welcome")
        assert len(welcomes) == 1
        assert welcomes[0]["data"]["sid"] == "sid1"

    def test_create_room_emits_room_created(self, env):
        peer = env["make_peer"]("sid1")
        peer.emit_event("create_room")
        assert env["rooms"].room_count == 1
        created = events_of(env["captured"], "room-created")
        assert len(created) == 1
        room_id = created[0]["data"]["room_id"]
        assert len(room_id) == 5
        assert room_id.isdigit()

    def test_join_room_notifies_both_peers(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id

        p2.emit_event("join_room", {"room_id": room_id})
        joined = events_of(env["captured"], "room-joined")
        assert len(joined) == 2
        initiators = {e["data"]["initiator"] for e in joined}
        assert initiators == {True, False}

    def test_offer_relayed_to_peer(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        p1.emit_event("offer", {"sdp": "offer-sdp-data"})
        offers = events_of(env["captured"], "offer")
        assert len(offers) == 1
        assert offers[0]["data"]["sdp"] == "offer-sdp-data"
        assert offers[0]["data"]["from"] == "sid1"
        assert offers[0]["room"] == "sid2"

    def test_answer_relayed_to_peer(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        p2.emit_event("answer", {"sdp": "answer-sdp-data"})
        answers = events_of(env["captured"], "answer")
        assert len(answers) == 1
        assert answers[0]["data"]["sdp"] == "answer-sdp-data"
        assert answers[0]["data"]["from"] == "sid2"
        assert answers[0]["room"] == "sid1"

    def test_ice_candidate_relayed_to_peer(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        p1.emit_event("ice_candidate", {"candidate": "candidate:1 1 udp ..."})
        ice = events_of(env["captured"], "ice-candidate")
        assert len(ice) == 1
        assert ice[0]["room"] == "sid2"

    def test_disconnect_notifies_peer(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        p1.disconnect()
        disconnects = events_of(env["captured"], "peer-disconnected")
        assert len(disconnects) == 1
        assert disconnects[0]["room"] == "sid2"

    def test_leave_room_notifies_peer(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        p1.emit_event("leave_room")
        disconnects = events_of(env["captured"], "peer-disconnected")
        assert len(disconnects) == 1
        assert disconnects[0]["room"] == "sid2"

    def test_offer_without_room_is_silent(self, env):
        p1 = env["make_peer"]("sid1")
        env["captured"].clear()
        p1.emit_event("offer", {"sdp": "orphan"})
        offers = events_of(env["captured"], "offer")
        assert len(offers) == 0

    def test_create_room_error_when_already_in_room(self, env):
        p1 = env["make_peer"]("sid1")
        p1.emit_event("create_room")
        env["captured"].clear()

        p1.emit_event("create_room")
        errors = events_of(env["captured"], "error")
        assert len(errors) == 1

    def test_join_nonexistent_room_error(self, env):
        p1 = env["make_peer"]("sid1")
        env["captured"].clear()
        p1.emit_event("join_room", {"room_id": "ZZZZZ"})
        errors = events_of(env["captured"], "error")
        assert len(errors) == 1

    def test_full_signaling_flow(self, env):
        """Integration: create room → join → offer → answer → ICE → leave."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")

        # Create room
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        assert room_id is not None

        # Join room
        p2.emit_event("join_room", {"room_id": room_id})
        assert env["rooms"].get_room(room_id).is_full

        env["captured"].clear()

        # SDP exchange
        p1.emit_event("offer", {"sdp": "offer-data"})
        p2.emit_event("answer", {"sdp": "answer-data"})

        # ICE exchange (both directions)
        p1.emit_event("ice_candidate", {"candidate": "ice-from-1"})
        p2.emit_event("ice_candidate", {"candidate": "ice-from-2"})

        offers = events_of(env["captured"], "offer")
        answers = events_of(env["captured"], "answer")
        ice = events_of(env["captured"], "ice-candidate")

        assert len(offers) == 1
        assert offers[0]["room"] == "sid2"
        assert len(answers) == 1
        assert answers[0]["room"] == "sid1"
        assert len(ice) == 2
        ice_rooms = {e["room"] for e in ice}
        assert ice_rooms == {"sid1", "sid2"}

        # Leave
        env["captured"].clear()
        p1.emit_event("leave_room")
        assert events_of(env["captured"], "peer-disconnected")[0]["room"] == "sid2"


class TestConnectionLoss:
    """Scenarios where peers disconnect unexpectedly (crash, network loss)."""

    def test_initiator_crashes_mid_call(self, env):
        """Initiator disconnects without leave_room — peer gets notified, room cleaned."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        # Abrupt disconnect (no leave_room)
        p1.disconnect()

        disconnects = events_of(env["captured"], "peer-disconnected")
        assert len(disconnects) == 1
        assert disconnects[0]["room"] == "sid2"
        assert disconnects[0]["data"]["room_id"] == room_id

        # Server cleaned up: p1 gone, room still exists with p2
        assert env["rooms"].get_peer("sid1") is None
        assert env["rooms"].peer_count == 1
        # p2 should still be in the room (can wait for reconnect or leave)
        assert env["rooms"].get_peer("sid2").room_id == room_id

    def test_joiner_crashes_mid_call(self, env):
        """Joiner disconnects without leave_room — initiator gets notified."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        env["captured"].clear()

        p2.disconnect()

        disconnects = events_of(env["captured"], "peer-disconnected")
        assert len(disconnects) == 1
        assert disconnects[0]["room"] == "sid1"
        assert env["rooms"].get_peer("sid2") is None
        # Initiator still in room
        assert env["rooms"].get_peer("sid1").room_id == room_id

    def test_both_peers_crash(self, env):
        """Both peers disconnect — room fully cleaned up."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        p1.disconnect()
        p2.disconnect()

        assert env["rooms"].peer_count == 0
        assert env["rooms"].room_count == 0
        assert env["rooms"].get_room(room_id) is None

    def test_creator_disconnects_before_anyone_joins(self, env):
        """Creator disconnects while waiting — room cleaned up, no notifications sent."""
        p1 = env["make_peer"]("sid1")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        env["captured"].clear()

        p1.disconnect()

        # Room should be fully cleaned up
        assert env["rooms"].get_room(room_id) is None
        assert env["rooms"].room_count == 0
        # No peer-disconnected since no one else was in the room
        disconnects = events_of(env["captured"], "peer-disconnected")
        assert len(disconnects) == 0

    def test_peer_disconnects_during_sdp_exchange(self, env):
        """Peer disconnects after offer but before answer — clean teardown."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        # Offer sent but p2 crashes before answering
        p1.emit_event("offer", {"sdp": "offer-data"})
        env["captured"].clear()

        p2.disconnect()

        disconnects = events_of(env["captured"], "peer-disconnected")
        assert len(disconnects) == 1
        assert disconnects[0]["room"] == "sid1"


class TestCleanSessionTeardown:
    """Clean session end: leave → rejoin → repeated cycles."""

    def test_leave_and_rejoin_same_room(self, env):
        """After leaving, a peer can rejoin the same room if it still exists."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        # p2 leaves
        p2.emit_event("leave_room")
        assert env["rooms"].get_peer("sid2").room_id is None
        assert env["rooms"].get_room(room_id) is not None  # p1 still in it

        # p2 rejoins
        joined = env["rooms"].join_room("sid2", room_id)
        assert joined is not None
        assert joined.is_full

    def test_leave_and_create_new_room(self, env):
        """After leaving, a peer can create a fresh room."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        # Both leave
        p1.emit_event("leave_room")
        p2.emit_event("leave_room")
        assert env["rooms"].room_count == 0

        # p1 creates new room
        p1.emit_event("create_room")
        new_room_id = env["rooms"].get_peer("sid1").room_id
        assert new_room_id is not None
        assert new_room_id != room_id

    def test_multiple_call_cycles(self, env):
        """Two peers can do multiple create→join→leave cycles cleanly."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")

        for _cycle in range(3):
            p1.emit_event("create_room")
            room_id = env["rooms"].get_peer("sid1").room_id
            p2.emit_event("join_room", {"room_id": room_id})
            assert env["rooms"].get_room(room_id).is_full

            p1.emit_event("leave_room")
            p2.emit_event("leave_room")
            assert env["rooms"].room_count == 0

        assert env["rooms"].peer_count == 2  # peers still registered

    def test_admin_status_reflects_room_changes(self, env):
        """Admin endpoint tracks room/peer count through full lifecycle."""
        flask_app = env["flask_app"]
        client = flask_app.test_client()

        # Empty
        resp = client.get("/admin/status")
        assert resp.get_json()["peers"] == 0
        assert resp.get_json()["rooms"] == 0

        # After connections + room creation
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        resp = client.get("/admin/status")
        assert resp.get_json()["peers"] == 2
        assert resp.get_json()["rooms"] == 0

        p1.emit_event("create_room")
        resp = client.get("/admin/status")
        assert resp.get_json()["rooms"] == 1

        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        resp = client.get("/admin/status")
        assert resp.get_json()["rooms"] == 1
        assert resp.get_json()["peers"] == 2

        # After disconnect
        p1.disconnect()
        p2.disconnect()
        resp = client.get("/admin/status")
        assert resp.get_json()["peers"] == 0
        assert resp.get_json()["rooms"] == 0

    def test_signaling_after_room_partner_left(self, env):
        """SDP/ICE events are silently dropped if partner already left."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        # p2 leaves
        p2.emit_event("leave_room")
        env["captured"].clear()

        # p1 sends offer — should be silently dropped (no peer to relay to)
        p1.emit_event("offer", {"sdp": "late-offer"})
        p1.emit_event("ice_candidate", {"candidate": "late-ice"})
        assert len(events_of(env["captured"], "offer")) == 0
        assert len(events_of(env["captured"], "ice-candidate")) == 0


class TestDashboardEndpoints:
    """REST admin endpoints for the server dashboard."""

    def test_status_includes_uptime(self):
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        resp = client.get("/admin/status")
        data = resp.get_json()
        assert data["status"] == "ok"
        assert "uptime_seconds" in data
        assert data["uptime_seconds"] >= 0

    def test_events_endpoint_empty(self):
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        resp = client.get("/admin/events")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["events"] == []

    def test_events_endpoint_with_limit(self, env):
        p1 = env["make_peer"]("sid1")
        p1.emit_event("create_room")
        p1.emit_event("leave_room")

        client = env["flask_app"].test_client()
        resp = client.get("/admin/events?limit=1")
        data = resp.get_json()
        assert len(data["events"]) == 1

    def test_events_track_full_lifecycle(self, env):
        """Events are logged for connect, room create, join, leave, disconnect."""
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        p1.emit_event("leave_room")
        p2.disconnect()

        events = env["rooms"].get_events(50)
        event_types = [e["event"] for e in events]
        assert "peer_connected" in event_types
        assert "room_created" in event_types
        assert "peer_joined" in event_types
        assert "peer_left" in event_types
        assert "peer_disconnected" in event_types

    def test_rooms_endpoint_empty(self):
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        resp = client.get("/admin/rooms")
        assert resp.status_code == 200
        assert resp.get_json()["rooms"] == []

    def test_rooms_endpoint_with_active_room(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        client = env["flask_app"].test_client()
        resp = client.get("/admin/rooms")
        data = resp.get_json()
        assert len(data["rooms"]) == 1
        assert data["rooms"][0]["room_id"] == room_id
        assert data["rooms"][0]["is_full"] is True
        assert len(data["rooms"][0]["peers"]) == 2

    def test_peers_endpoint_empty(self):
        flask_app, _, _ = create_app()
        client = flask_app.test_client()
        resp = client.get("/admin/peers")
        assert resp.status_code == 200
        assert resp.get_json()["peers"] == []

    def test_peers_endpoint_with_connected_peers(self, env):
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        p1.emit_event("create_room")
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})

        client = env["flask_app"].test_client()
        resp = client.get("/admin/peers")
        data = resp.get_json()
        assert len(data["peers"]) == 2
        sids = {p["sid"] for p in data["peers"]}
        assert sids == {"sid1", "sid2"}
        # Each peer should see the other
        for p in data["peers"]:
            assert p["room_id"] == room_id
            assert p["peer"] is not None

    def test_peers_after_disconnect(self, env):
        p1 = env["make_peer"]("sid1")
        p1.disconnect()

        client = env["flask_app"].test_client()
        resp = client.get("/admin/peers")
        assert resp.get_json()["peers"] == []

    def test_status_counts_update_through_lifecycle(self, env):
        """Status endpoint reflects room/peer counts at each stage."""
        client = env["flask_app"].test_client()

        # Initial
        assert client.get("/admin/status").get_json()["peers"] == 0

        # Connect peers
        p1 = env["make_peer"]("sid1")
        p2 = env["make_peer"]("sid2")
        status = client.get("/admin/status").get_json()
        assert status["peers"] == 2
        assert status["rooms"] == 0

        # Create room
        p1.emit_event("create_room")
        status = client.get("/admin/status").get_json()
        assert status["rooms"] == 1

        # Join
        room_id = env["rooms"].get_peer("sid1").room_id
        p2.emit_event("join_room", {"room_id": room_id})
        status = client.get("/admin/status").get_json()
        assert status["rooms"] == 1
        assert status["peers"] == 2

        # Leave + disconnect both
        p1.emit_event("leave_room")
        p1.disconnect()
        p2.disconnect()
        status = client.get("/admin/status").get_json()
        assert status["rooms"] == 0
        assert status["peers"] == 0
