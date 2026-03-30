"""Unit tests for signaling.rooms — room management logic."""

import pytest

from signaling.rooms import Room, RoomManager


class TestRoom:
    """Room dataclass behavior."""

    def test_empty_room(self):
        r = Room(room_id="ABCDE")
        assert r.is_empty
        assert not r.is_full
        assert r.other_peer("x") is None

    def test_one_peer(self):
        r = Room(room_id="ABCDE", peers=["sid1"])
        assert not r.is_empty
        assert not r.is_full
        assert r.other_peer("sid1") is None
        assert r.other_peer("sid2") is None

    def test_two_peers(self):
        r = Room(room_id="ABCDE", peers=["sid1", "sid2"])
        assert r.is_full
        assert r.other_peer("sid1") == "sid2"
        assert r.other_peer("sid2") == "sid1"


class TestRoomManager:
    """RoomManager lifecycle operations."""

    @pytest.fixture
    def mgr(self):
        return RoomManager()

    def test_register_and_unregister_peer(self, mgr):
        peer = mgr.register_peer("sid1")
        assert peer.sid == "sid1"
        assert peer.room_id is None
        assert mgr.peer_count == 1
        mgr.unregister_peer("sid1")
        assert mgr.peer_count == 0

    def test_unregister_unknown_peer(self, mgr):
        assert mgr.unregister_peer("unknown") is None

    def test_create_room(self, mgr):
        mgr.register_peer("sid1")
        room = mgr.create_room("sid1")
        assert room is not None
        assert len(room.room_id) == 5
        assert room.room_id.isdigit()
        assert 10000 <= int(room.room_id) <= 99999
        assert room.peers == ["sid1"]
        assert mgr.room_count == 1
        assert mgr.get_peer("sid1").room_id == room.room_id

    def test_create_room_unregistered_peer(self, mgr):
        assert mgr.create_room("unknown") is None

    def test_create_room_already_in_room(self, mgr):
        mgr.register_peer("sid1")
        mgr.create_room("sid1")
        assert mgr.create_room("sid1") is None

    def test_join_room(self, mgr):
        mgr.register_peer("sid1")
        mgr.register_peer("sid2")
        room = mgr.create_room("sid1")
        joined = mgr.join_room("sid2", room.room_id)
        assert joined is not None
        assert joined.is_full
        assert joined.other_peer("sid1") == "sid2"

    def test_join_nonexistent_room(self, mgr):
        mgr.register_peer("sid1")
        assert mgr.join_room("sid1", "ZZZZZ") is None

    def test_join_full_room(self, mgr):
        mgr.register_peer("sid1")
        mgr.register_peer("sid2")
        mgr.register_peer("sid3")
        room = mgr.create_room("sid1")
        mgr.join_room("sid2", room.room_id)
        assert mgr.join_room("sid3", room.room_id) is None

    def test_join_while_already_in_room(self, mgr):
        mgr.register_peer("sid1")
        mgr.register_peer("sid2")
        room1 = mgr.create_room("sid1")
        mgr.create_room("sid2")
        assert mgr.join_room("sid2", room1.room_id) is None

    def test_leave_room(self, mgr):
        mgr.register_peer("sid1")
        mgr.register_peer("sid2")
        room = mgr.create_room("sid1")
        mgr.join_room("sid2", room.room_id)
        room_id = mgr.leave_room("sid1")
        assert room_id == room.room_id
        assert mgr.get_peer("sid1").room_id is None
        # Room still exists with one peer
        assert mgr.get_room(room.room_id) is not None

    def test_leave_room_last_peer_cleans_up(self, mgr):
        mgr.register_peer("sid1")
        room = mgr.create_room("sid1")
        room_id = room.room_id
        mgr.leave_room("sid1")
        assert mgr.get_room(room_id) is None
        assert mgr.room_count == 0

    def test_leave_room_not_in_room(self, mgr):
        mgr.register_peer("sid1")
        assert mgr.leave_room("sid1") is None

    def test_unregister_peer_cleans_up_room(self, mgr):
        mgr.register_peer("sid1")
        room = mgr.create_room("sid1")
        room_id = room.room_id
        mgr.unregister_peer("sid1")
        assert mgr.get_room(room_id) is None

    def test_get_peer_room(self, mgr):
        mgr.register_peer("sid1")
        assert mgr.get_peer_room("sid1") is None
        room = mgr.create_room("sid1")
        assert mgr.get_peer_room("sid1") == room

    def test_room_ids_are_unique(self, mgr):
        """Create many rooms and verify no ID collisions."""
        ids = set()
        for i in range(50):
            sid = f"sid{i}"
            mgr.register_peer(sid)
            room = mgr.create_room(sid)
            assert room.room_id not in ids
            ids.add(room.room_id)
