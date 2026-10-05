/**
 * Room management for the signaling server.
 *
 * Tracks which Socket.IO sids are in which rooms, enforces 1:1 pairing, and
 * provides the room lifecycle. Room ids are unguessable capability tokens:
 * knowing the id IS the invitation, so they are generated from a CSPRNG and
 * never leave the server whole except to the peers that own them.
 */
import { randomBytes } from 'node:crypto';

/** 16 bytes — about 128 bits of entropy in a 22-character URL-safe string. */
const ROOM_TOKEN_BYTES = 16;
const MAX_ID_ATTEMPTS = 8;
const MAX_PEERS_PER_ROOM = 2;
const MAX_EVENTS = 100;

/** A URL-safe token, matching Python's `secrets.token_urlsafe`. */
function tokenUrlsafe(bytes) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Shorten an identifier for dashboards and logs. Room ids are join
 * capabilities and sids address Socket.IO clients directly; neither may appear
 * whole anywhere a reader is not already entitled to it.
 */
export function redact(value) {
  if (!value) return null;
  return `${value.slice(0, 4)}…`;
}

/** A 1:1 room holding up to two peers. */
export class Room {
  constructor(roomId, peers = []) {
    this.roomId = roomId;
    this.peers = peers;
  }

  get isFull() {
    return this.peers.length >= MAX_PEERS_PER_ROOM;
  }

  get isEmpty() {
    return this.peers.length === 0;
  }

  /** The other peer in this room, or null. A sid not in the room gets null. */
  otherPeer(sid) {
    if (!this.peers.includes(sid)) return null;
    return this.peers.find((peer) => peer !== sid) ?? null;
  }
}

export class RoomManager {
  constructor() {
    this._rooms = new Map();
    this._peers = new Map();
    this._events = [];
    this._startTime = process.hrtime.bigint();
  }

  /** @private a token no live room already holds. */
  _generateRoomId() {
    for (let i = 0; i < MAX_ID_ATTEMPTS; i++) {
      const roomId = tokenUrlsafe(ROOM_TOKEN_BYTES);
      if (!this._rooms.has(roomId)) return roomId;
    }
    // Eight straight collisions at 128 bits of entropy is not chance.
    throw new Error('Could not generate a unique room token');
  }

  registerPeer(sid) {
    const peer = { sid, roomId: null };
    this._peers.set(sid, peer);
    return peer;
  }

  /** Remove a peer and leave any room they were in. Returns that room id. */
  unregisterPeer(sid) {
    const peer = this._peers.get(sid);
    if (!peer) return null;
    this._peers.delete(sid);
    const roomId = peer.roomId;
    const room = roomId ? this._rooms.get(roomId) : null;
    if (room) {
      room.peers = room.peers.filter((p) => p !== sid);
      if (room.isEmpty) this._rooms.delete(roomId);
    }
    return roomId;
  }

  /** A new room with this peer as its first occupant, or null. */
  createRoom(sid) {
    const peer = this._peers.get(sid);
    if (!peer || peer.roomId !== null) return null;
    const roomId = this._generateRoomId();
    const room = new Room(roomId, [sid]);
    this._rooms.set(roomId, room);
    peer.roomId = roomId;
    return room;
  }

  /** Join an existing room, or null when it is missing, full, or ineligible. */
  joinRoom(sid, roomId) {
    const peer = this._peers.get(sid);
    if (!peer || peer.roomId !== null) return null;
    const room = this._rooms.get(roomId);
    if (!room || room.isFull) return null;
    room.peers.push(sid);
    peer.roomId = roomId;
    return room;
  }

  /** Remove a peer from their room. Returns the room id they left. */
  leaveRoom(sid) {
    const peer = this._peers.get(sid);
    if (!peer || peer.roomId === null) return null;
    const roomId = peer.roomId;
    peer.roomId = null;
    const room = this._rooms.get(roomId);
    if (room) {
      room.peers = room.peers.filter((p) => p !== sid);
      if (room.isEmpty) this._rooms.delete(roomId);
    }
    return roomId;
  }

  getRoom(roomId) {
    return this._rooms.get(roomId) ?? null;
  }

  getPeer(sid) {
    return this._peers.get(sid) ?? null;
  }

  getPeerRoom(sid) {
    const peer = this._peers.get(sid);
    if (!peer || peer.roomId === null) return null;
    return this._rooms.get(peer.roomId) ?? null;
  }

  get roomCount() {
    return this._rooms.size;
  }

  get peerCount() {
    return this._peers.size;
  }

  get uptimeSeconds() {
    return Number(process.hrtime.bigint() - this._startTime) / 1e9;
  }

  /** Record an event for the dashboard, with identifiers stored redacted. */
  logEvent(event, fields = {}) {
    const entry = { timestamp: Date.now() / 1000, event };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = key === 'sid' || key === 'room_id' ? redact(value) : value;
    }
    this._events.push(entry);
    if (this._events.length > MAX_EVENTS) {
      this._events = this._events.slice(-MAX_EVENTS);
    }
  }

  getEvents(limit = 20) {
    return this._events.slice(-limit);
  }

  /**
   * Active rooms for the dashboard. Full ids are join capabilities, so this
   * gives a prefix that identifies a room without granting entry, and peer
   * counts rather than sids.
   */
  getRoomsSummary() {
    return [...this._rooms.values()].map((room) => ({
      room: redact(room.roomId),
      peer_count: room.peers.length,
      is_full: room.isFull,
    }));
  }

  getPeersSummary() {
    return [...this._peers.entries()].map(([sid, peer]) => {
      const room = peer.roomId ? this._rooms.get(peer.roomId) : null;
      return {
        peer: redact(sid),
        room: redact(peer.roomId),
        paired: room ? room.otherPeer(sid) !== null : false,
      };
    });
  }
}
