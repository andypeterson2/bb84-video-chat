// @vitest-environment node
/** Room lifecycle, 1:1 pairing, and the redaction the dashboard depends on. */
import { describe, test, expect, beforeEach } from 'vitest';
import { RoomManager, Room, redact } from '../../server/rooms.js';

let rooms;

beforeEach(() => {
  rooms = new RoomManager();
});

describe('redact', () => {
  test('keeps a prefix that identifies without granting entry', () => {
    expect(redact('abcdefghijklmnop')).toBe('abcd…');
  });

  test('absent identifiers stay absent', () => {
    expect(redact(null)).toBeNull();
    expect(redact('')).toBeNull();
  });
});

describe('room tokens', () => {
  test('are long enough to be unguessable', () => {
    const room = rooms.registerPeer('a') && rooms.createRoom('a');
    // 16 bytes base64url, so 22 characters with no padding.
    expect(room.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test('differ between rooms', () => {
    rooms.registerPeer('a');
    rooms.registerPeer('b');
    const first = rooms.createRoom('a').roomId;
    const second = rooms.createRoom('b').roomId;
    expect(first).not.toBe(second);
  });
});

describe('creating and joining', () => {
  test('an unregistered peer cannot create a room', () => {
    expect(rooms.createRoom('ghost')).toBeNull();
  });

  test('a peer already in a room cannot create another', () => {
    rooms.registerPeer('a');
    expect(rooms.createRoom('a')).not.toBeNull();
    expect(rooms.createRoom('a')).toBeNull();
  });

  test('joining a room that does not exist fails', () => {
    rooms.registerPeer('a');
    expect(rooms.joinRoom('a', 'nope')).toEqual({ room: null, reason: 'no-such-room' });
  });

  test('a third peer cannot join a full room', () => {
    for (const sid of ['a', 'b', 'c']) rooms.registerPeer(sid);
    const room = rooms.createRoom('a');
    expect(rooms.joinRoom('b', room.roomId).room).not.toBeNull();
    expect(rooms.joinRoom('c', room.roomId)).toEqual({ room: null, reason: 'room-full' });
  });

  test('a peer already in a room cannot join another', () => {
    for (const sid of ['a', 'b']) rooms.registerPeer(sid);
    const first = rooms.createRoom('a');
    const second = rooms.createRoom('b');
    expect(rooms.joinRoom('a', second.roomId)).toEqual({
      room: null,
      reason: 'already-in-a-room',
    });
    expect(first.peers).toEqual(['a']);
  });
});

describe('pairing', () => {
  test('each peer sees the other', () => {
    for (const sid of ['a', 'b']) rooms.registerPeer(sid);
    const room = rooms.createRoom('a');
    rooms.joinRoom('b', room.roomId);
    expect(room.otherPeer('a')).toBe('b');
    expect(room.otherPeer('b')).toBe('a');
  });

  test('a stranger to the room is told about nobody', () => {
    const room = new Room('r', ['a', 'b']);
    expect(room.otherPeer('c')).toBeNull();
  });

  test('a lone occupant has no peer', () => {
    rooms.registerPeer('a');
    const room = rooms.createRoom('a');
    expect(room.otherPeer('a')).toBeNull();
  });
});

describe('leaving', () => {
  test('an empty room is dropped', () => {
    rooms.registerPeer('a');
    const room = rooms.createRoom('a');
    rooms.leaveRoom('a');
    expect(rooms.getRoom(room.roomId)).toBeNull();
    expect(rooms.roomCount).toBe(0);
  });

  test('a room with someone left in it survives', () => {
    for (const sid of ['a', 'b']) rooms.registerPeer(sid);
    const room = rooms.createRoom('a');
    rooms.joinRoom('b', room.roomId);
    rooms.leaveRoom('a');
    expect(rooms.getRoom(room.roomId)).not.toBeNull();
    expect(room.peers).toEqual(['b']);
  });

  test('leaving when in no room reports nothing', () => {
    rooms.registerPeer('a');
    expect(rooms.leaveRoom('a')).toBeNull();
  });

  test('unregistering also leaves the room', () => {
    for (const sid of ['a', 'b']) rooms.registerPeer(sid);
    const room = rooms.createRoom('a');
    rooms.joinRoom('b', room.roomId);
    expect(rooms.unregisterPeer('a')).toBe(room.roomId);
    expect(room.peers).toEqual(['b']);
    expect(rooms.peerCount).toBe(1);
  });

  test('unregistering someone unknown is harmless', () => {
    expect(rooms.unregisterPeer('ghost')).toBeNull();
  });
});

describe('the dashboard view', () => {
  test('rooms are summarised without their join tokens', () => {
    for (const sid of ['a', 'b']) rooms.registerPeer(sid);
    const room = rooms.createRoom('a');
    rooms.joinRoom('b', room.roomId);
    const [summary] = rooms.getRoomsSummary();
    expect(summary.room).toBe(redact(room.roomId));
    expect(summary.room).not.toBe(room.roomId);
    expect(summary).toMatchObject({ peer_count: 2, is_full: true });
  });

  test('peers are summarised without their sids', () => {
    rooms.registerPeer('abcdefgh');
    const [summary] = rooms.getPeersSummary();
    expect(summary.peer).toBe('abcd…');
    expect(summary).toMatchObject({ room: null, paired: false });
  });

  test('events store identifiers redacted', () => {
    rooms.logEvent('room_created', { sid: 'abcdefgh', room_id: 'zyxwvuts', extra: 'kept' });
    const [event] = rooms.getEvents();
    expect(event.sid).toBe('abcd…');
    expect(event.room_id).toBe('zyxw…');
    expect(event.extra).toBe('kept');
  });

  test('the event log is bounded', () => {
    for (let i = 0; i < 150; i++) rooms.logEvent('tick', { n: i });
    expect(rooms.getEvents(1000).length).toBe(100);
  });
});
