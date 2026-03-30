"""Room management for signaling server.

Tracks which Socket.IO sids are in which rooms, enforces 1:1 pairing,
and provides room lifecycle operations (create, join, leave, query).
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field

_ROOM_ID_LENGTH = 5
_ROOM_ID_MIN = 10000
_ROOM_ID_MAX = 99999
_MAX_PEERS_PER_ROOM = 2


@dataclass
class Peer:
    """A connected peer in the signaling server."""

    sid: str
    room_id: str | None = None


@dataclass
class Room:
    """A 1:1 room containing up to two peers."""

    room_id: str
    peers: list[str] = field(default_factory=list)  # list of sids

    @property
    def is_full(self) -> bool:
        """Return True if the room has two peers."""
        return len(self.peers) >= _MAX_PEERS_PER_ROOM

    @property
    def is_empty(self) -> bool:
        """Return True if the room has no peers."""
        return len(self.peers) == 0

    def other_peer(self, sid: str) -> str | None:
        """Return the sid of the other peer in the room, or None.

        Only returns a peer that is actually in this room.
        If ``sid`` is not in the room, returns None.
        """
        if sid not in self.peers:
            return None
        for peer_sid in self.peers:
            if peer_sid != sid:
                return peer_sid
        return None


class RoomManager:
    """Manages rooms and peer-to-room mappings.

    Thread-safe for single-threaded async servers (Socket.IO with eventlet/gevent).
    """

    def __init__(self) -> None:
        """Initialize empty room and peer registries."""
        self._rooms: dict[str, Room] = {}
        self._peers: dict[str, Peer] = {}
        self._events: list[dict] = []
        self._start_time: float = time.monotonic()
        self._max_events: int = 100

    def _generate_room_id(self) -> str:
        """Generate a unique 5-digit numeric room ID."""
        while True:
            room_id = str(secrets.randbelow(_ROOM_ID_MAX - _ROOM_ID_MIN + 1) + _ROOM_ID_MIN)
            if room_id not in self._rooms:
                return room_id

    def register_peer(self, sid: str) -> Peer:
        """Register a new peer connection.

        Args:
            sid: Socket.IO session ID.

        Returns:
            The newly registered Peer.
        """
        peer = Peer(sid=sid)
        self._peers[sid] = peer
        return peer

    def unregister_peer(self, sid: str) -> str | None:
        """Remove a peer and leave any room they were in.

        Args:
            sid: Socket.IO session ID.

        Returns:
            The room_id they were in, or None.
        """
        peer = self._peers.pop(sid, None)
        if peer is None:
            return None
        room_id = peer.room_id
        if room_id and room_id in self._rooms:
            room = self._rooms[room_id]
            if sid in room.peers:
                room.peers.remove(sid)
            if room.is_empty:
                del self._rooms[room_id]
        return room_id

    def create_room(self, sid: str) -> Room | None:
        """Create a new room with the given peer as the first occupant.

        Args:
            sid: Socket.IO session ID of the creating peer.

        Returns:
            The new Room, or None if the peer is not registered or already in a room.
        """
        peer = self._peers.get(sid)
        if peer is None or peer.room_id is not None:
            return None
        room_id = self._generate_room_id()
        room = Room(room_id=room_id, peers=[sid])
        self._rooms[room_id] = room
        peer.room_id = room_id
        return room

    def join_room(self, sid: str, room_id: str) -> Room | None:
        """Join an existing room.

        Args:
            sid: Socket.IO session ID of the joining peer.
            room_id: The room to join.

        Returns:
            The Room if successfully joined, or None if room doesn't exist,
            is full, or peer is not registered / already in a room.
        """
        peer = self._peers.get(sid)
        if peer is None or peer.room_id is not None:
            return None
        room = self._rooms.get(room_id)
        if room is None or room.is_full:
            return None
        room.peers.append(sid)
        peer.room_id = room_id
        return room

    def leave_room(self, sid: str) -> str | None:
        """Remove a peer from their current room.

        Args:
            sid: Socket.IO session ID.

        Returns:
            The room_id they left, or None if they weren't in a room.
        """
        peer = self._peers.get(sid)
        if peer is None or peer.room_id is None:
            return None
        room_id = peer.room_id
        peer.room_id = None
        room = self._rooms.get(room_id)
        if room:
            if sid in room.peers:
                room.peers.remove(sid)
            if room.is_empty:
                del self._rooms[room_id]
        return room_id

    def get_room(self, room_id: str) -> Room | None:
        """Get a room by ID."""
        return self._rooms.get(room_id)

    def get_peer(self, sid: str) -> Peer | None:
        """Get a peer by SID."""
        return self._peers.get(sid)

    def get_peer_room(self, sid: str) -> Room | None:
        """Get the room a peer is in."""
        peer = self._peers.get(sid)
        if peer is None or peer.room_id is None:
            return None
        return self._rooms.get(peer.room_id)

    @property
    def room_count(self) -> int:
        """Number of active rooms."""
        return len(self._rooms)

    @property
    def peer_count(self) -> int:
        """Number of registered peers."""
        return len(self._peers)

    @property
    def uptime_seconds(self) -> float:
        """Seconds since the RoomManager was created."""
        return time.monotonic() - self._start_time

    def log_event(self, event: str, **kwargs) -> None:
        """Record an event for the dashboard."""
        entry = {"timestamp": time.time(), "event": event, **kwargs}
        self._events.append(entry)
        if len(self._events) > self._max_events:
            self._events = self._events[-self._max_events:]

    def get_events(self, limit: int = 20) -> list[dict]:
        """Return the most recent events."""
        return self._events[-limit:]

    def get_rooms_summary(self) -> list[dict]:
        """Return a summary of all active rooms for the dashboard."""
        result = []
        for room_id, room in self._rooms.items():
            result.append({
                "room_id": room_id,
                "peers": list(room.peers),
                "is_full": room.is_full,
            })
        return result

    def get_peers_summary(self) -> list[dict]:
        """Return a summary of all registered peers for the dashboard."""
        result = []
        for sid, peer in self._peers.items():
            room = self._rooms.get(peer.room_id) if peer.room_id else None
            result.append({
                "sid": sid,
                "room_id": peer.room_id,
                "peer": room.other_peer(sid) if room else None,
            })
        return result
