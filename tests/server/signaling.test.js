// @vitest-environment node
/** The signalling flows: rooms, relay, lifecycle, and what survives a crash. */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { serve, connect, next, paired, saveEnv, restoreEnv } from './helpers.js';

let env;
let running;
const sockets = [];

/** Track a socket so it is closed even when a test fails partway. */
function track(socket) {
  sockets.push(socket);
  return socket;
}

beforeEach(async () => {
  env = saveEnv();
  running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await running.stop();
  restoreEnv(env);
});

const admin = (path) =>
  fetch(`${running.url}${path}`, { headers: { 'X-Admin-Secret': 'letmein' } }).then((r) =>
    r.json(),
  );

/** A short settle, so a test can assert that nothing arrived. */
const settle = () => new Promise((r) => setTimeout(r, 120));

describe('connecting', () => {
  test('a new peer is welcomed with its own sid', async () => {
    const socket = track(await connect(running.url));
    expect(socket.id).toBeTruthy();
  });

  test('status counts the peer', async () => {
    track(await connect(running.url));
    expect((await admin('/admin/status')).peers).toBe(1);
  });

  test('health reports uptime', async () => {
    const body = await (await fetch(`${running.url}/health`)).json();
    expect(body).toMatchObject({ status: 'ok', service: 'qvc' });
    expect(typeof body.uptime_s).toBe('number');
  });
});

describe('rooms', () => {
  test('creating one returns a token', async () => {
    const a = track(await connect(running.url));
    a.emit('create_room');
    const { room_id: roomId } = await next(a, 'room-created');
    expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test('joining notifies both peers, and names the initiator', async () => {
    const a = track(await connect(running.url));
    const b = track(await connect(running.url));
    a.emit('create_room');
    const { room_id: roomId } = await next(a, 'room-created');
    const creatorSees = next(a, 'room-joined');
    b.emit('join_room', { room_id: roomId });
    const joinerSees = await next(b, 'room-joined');
    expect((await creatorSees).initiator).toBe(true);
    expect(joinerSees.initiator).toBe(false);
    expect(joinerSees.room_id).toBe(roomId);
  });

  test('creating a second room while in one is refused', async () => {
    const a = track(await connect(running.url));
    a.emit('create_room');
    await next(a, 'room-created');
    const failure = next(a, 'error');
    a.emit('create_room');
    expect((await failure).message).toMatch(/Cannot create room/);
  });

  test('joining a room that does not exist says the invite is stale', async () => {
    const a = track(await connect(running.url));
    const failure = next(a, 'error');
    a.emit('join_room', { room_id: 'nope' });
    const refusal = await failure;
    expect(refusal.reason).toBe('no-such-room');
    expect(refusal.message).toMatch(/no longer valid/);
  });

  test('a third peer is told the call is full', async () => {
    const [a, , roomId] = await paired(running.url);
    const c = track(await connect(running.url));
    const failure = next(c, 'error');
    c.emit('join_room', { room_id: roomId });
    const refusal = await failure;
    expect(refusal.reason).toBe('room-full');
    expect(a.connected).toBe(true);
  });

  test('a peer already in a call is told to leave it first', async () => {
    const [a] = await paired(running.url);
    const failure = next(a, 'error');
    a.emit('join_room', { room_id: 'anything' });
    expect((await failure).reason).toBe('already-in-a-room');
  });

  test('a join accepts a bare string as well as an object', async () => {
    const a = track(await connect(running.url));
    const b = track(await connect(running.url));
    a.emit('create_room');
    const { room_id: roomId } = await next(a, 'room-created');
    b.emit('join_room', roomId);
    expect((await next(b, 'room-joined')).room_id).toBe(roomId);
  });
});

describe('relay', () => {
  test('an offer reaches the peer, stamped with its sender', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    const arriving = next(b, 'offer');
    a.emit('offer', { sdp: 'v=0 fake' });
    const offer = await arriving;
    expect(offer).toMatchObject({ sdp: 'v=0 fake', from: a.id });
  });

  test('an answer reaches the peer', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    const arriving = next(a, 'answer');
    b.emit('answer', { sdp: 'v=0 answer' });
    expect((await arriving).sdp).toBe('v=0 answer');
  });

  test('an ICE candidate reaches the peer', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    const arriving = next(b, 'ice-candidate');
    a.emit('ice_candidate', { candidate: 'candidate:1 1 udp' });
    expect((await arriving).candidate).toBe('candidate:1 1 udp');
  });

  test('an ICE-restart request reaches the peer', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    const arriving = next(a, 'request-ice-restart');
    b.emit('request_ice_restart');
    await expect(arriving).resolves.toBeDefined();
  });

  test('the eavesdropper demo state reaches the peer as a boolean', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    const arriving = next(b, 'eve-demo');
    a.emit('eve_demo', { active: 'yes' });
    expect((await arriving).active).toBe(true);
  });

  test('relaying without a room says nothing at all', async () => {
    const a = track(await connect(running.url));
    const b = track(await connect(running.url));
    let heard = false;
    for (const event of ['offer', 'answer', 'ice-candidate', 'request-ice-restart']) {
      b.on(event, () => {
        heard = true;
      });
    }
    a.emit('offer', { sdp: 'x' });
    a.emit('request_ice_restart');
    await settle();
    expect(heard).toBe(false);
  });

  test('a non-object payload is ignored rather than relayed', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    let heard = false;
    for (const event of ['offer', 'answer', 'ice-candidate', 'eve-demo']) {
      b.on(event, () => {
        heard = true;
      });
    }
    a.emit('offer', 'not-an-object');
    a.emit('answer', 42);
    a.emit('ice_candidate', null);
    a.emit('eve_demo', 'on');
    await settle();
    expect(heard).toBe(false);
  });
});

describe('leaving and crashing', () => {
  test('a disconnect tells the partner', async () => {
    const [a, b, roomId] = await paired(running.url);
    track(b);
    const notice = next(b, 'peer-disconnected');
    a.disconnect();
    expect((await notice).room_id).toBe(roomId);
  });

  test('an explicit leave tells the partner', async () => {
    const [a, b, roomId] = await paired(running.url);
    track(a);
    track(b);
    const notice = next(b, 'peer-disconnected');
    a.emit('leave_room');
    expect((await notice).room_id).toBe(roomId);
  });

  test('the creator leaving before anyone joins drops the room', async () => {
    const a = track(await connect(running.url));
    a.emit('create_room');
    await next(a, 'room-created');
    a.disconnect();
    await settle();
    expect((await admin('/admin/status')).rooms).toBe(0);
  });

  test('both peers crashing leaves nothing behind', async () => {
    const [a, b] = await paired(running.url);
    a.disconnect();
    b.disconnect();
    await settle();
    expect(await admin('/admin/status')).toMatchObject({ rooms: 0, peers: 0 });
  });

  test('signalling after the partner left is silent, not an error', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    b.disconnect();
    await next(a, 'peer-disconnected');
    let errored = false;
    a.on('error', () => {
      errored = true;
    });
    a.emit('offer', { sdp: 'x' });
    await settle();
    expect(errored).toBe(false);
  });

  test('a peer can leave and then join the same room again', async () => {
    const [a, b, roomId] = await paired(running.url);
    track(a);
    track(b);
    b.emit('leave_room');
    await next(a, 'peer-disconnected');
    b.emit('join_room', { room_id: roomId });
    expect((await next(b, 'room-joined')).room_id).toBe(roomId);
  });

  test('a peer can leave and create a room of its own', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    b.emit('leave_room');
    await next(a, 'peer-disconnected');
    b.emit('create_room');
    await expect(next(b, 'room-created')).resolves.toBeDefined();
  });

  test('several call cycles leave the counts where they started', async () => {
    for (let i = 0; i < 3; i++) {
      const [a, b] = await paired(running.url);
      a.disconnect();
      b.disconnect();
      await settle();
    }
    expect(await admin('/admin/status')).toMatchObject({ rooms: 0, peers: 0 });
  });
});

describe('the dashboard', () => {
  test('events track the lifecycle with identifiers redacted', async () => {
    const [a, b, roomId] = await paired(running.url);
    track(a);
    track(b);
    const { events } = await admin('/admin/events?limit=100');
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain('peer_connected');
    expect(kinds).toContain('room_created');
    expect(kinds).toContain('peer_joined');
    const created = events.find((e) => e.event === 'room_created');
    expect(created.room_id).not.toBe(roomId);
    expect(created.room_id.endsWith('…')).toBe(true);
  });

  test('rooms are listed without their join tokens', async () => {
    const [a, b, roomId] = await paired(running.url);
    track(a);
    track(b);
    const { rooms } = await admin('/admin/rooms');
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ peer_count: 2, is_full: true });
    expect(rooms[0].room).not.toBe(roomId);
  });

  test('peers are listed as paired once a room has two', async () => {
    const [a, b] = await paired(running.url);
    track(a);
    track(b);
    const { peers } = await admin('/admin/peers');
    expect(peers).toHaveLength(2);
    expect(peers.every((p) => p.paired)).toBe(true);
  });

  test('a disconnect is reflected in the peer list', async () => {
    const [a, b] = await paired(running.url);
    track(b);
    a.disconnect();
    await settle();
    const { peers } = await admin('/admin/peers');
    expect(peers).toHaveLength(1);
    expect(peers[0].paired).toBe(false);
  });

  test('the empty server reports empty collections', async () => {
    expect((await admin('/admin/rooms')).rooms).toEqual([]);
    expect((await admin('/admin/peers')).peers).toEqual([]);
  });
});

describe('discovery', () => {
  test('lists the HTTP endpoints and the streaming channels', async () => {
    const body = await (await fetch(`${running.url}/api`)).json();
    expect(body.service).toBe('qvc');
    const paths = body.endpoints.map((e) => e.path);
    for (const path of ['/health', '/ice-servers', '/api', '/admin/status']) {
      expect(paths).toContain(path);
    }
    const events = body.streaming.map((s) => s.event);
    for (const event of ['welcome', 'offer', 'answer', 'ice-candidate', 'room-created']) {
      expect(events).toContain(event);
    }
  });

  test('ice-servers hands the browser a STUN entry', async () => {
    const body = await (await fetch(`${running.url}/ice-servers`)).json();
    expect(Array.isArray(body.iceServers)).toBe(true);
    expect(body.iceServers[0].urls[0]).toMatch(/^stun:/);
  });

  test('an unknown route uses the error envelope', async () => {
    const res = await fetch(`${running.url}/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});
