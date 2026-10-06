/**
 * Signaling server: Express + Socket.IO for WebRTC connection establishment.
 *
 * Responsibilities:
 *   - Relay SDP offers/answers between peers
 *   - Relay ICE candidates between peers
 *   - Manage rooms (create, join, leave)
 *   - Provide an admin status surface
 *
 * Non-responsibilities:
 *   - Media transport, which is peer-to-peer WebRTC
 *   - Encryption, which the browser does with insertable streams
 *   - Key exchange, which runs over the RTCDataChannel as BB84
 */
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import { RoomManager, redact } from './rooms.js';
import { RateLimiter } from './throttle.js';
import { iceServers } from './turn.js';

export const SERVICE = 'qvc';

/**
 * Streaming channels are not in the HTTP route table, so they are listed by
 * hand. The encrypted media and BB84 path runs peer-to-peer in the browser and
 * is the explicit live-only layer.
 */
const STREAMING = [
  {
    protocol: 'socket.io',
    event: 'welcome',
    description: "Connection acknowledgement carrying the peer's sid.",
  },
  { protocol: 'socket.io', event: 'offer', description: 'Relay SDP offer to the room peer.' },
  { protocol: 'socket.io', event: 'answer', description: 'Relay SDP answer to the room peer.' },
  {
    protocol: 'socket.io',
    event: 'ice-candidate',
    description: 'Relay ICE candidate to the room peer.',
  },
  {
    protocol: 'socket.io',
    event: 'request-ice-restart',
    description: 'Ask the initiator to restart ICE.',
  },
  { protocol: 'socket.io', event: 'room-created', description: 'Room-creation result.' },
  { protocol: 'socket.io', event: 'room-joined', description: 'Room-join result (both peers).' },
  {
    protocol: 'socket.io',
    event: 'peer-disconnected',
    description: 'Peer left/disconnected notification.',
  },
  {
    protocol: 'socket.io',
    event: 'eve-demo',
    description: 'Relay the eavesdropper-demo state to the peer.',
  },
  {
    protocol: 'socket.io',
    event: 'error',
    description: 'Rate-limit or room-operation failure notice.',
  },
  {
    protocol: 'webrtc',
    description:
      'Encrypted media + BB84/QKD run peer-to-peer in the browser; not brokered by this server.',
  },
];

/**
 * Why a join was refused, in words the person who clicked a link can act on.
 * Rooms are held in memory, so every live invite points at a room that exists
 * only until this process restarts.
 */
const JOIN_REFUSALS = {
  'already-in-a-room': 'You are already in a call. Leave it before joining another.',
  'no-such-room': 'That invite is no longer valid — the server restarted. Ask for a new link.',
  'room-full': 'That call already has two people in it.',
};

/** HTTP endpoints, declared beside their handlers so /api can list them. */
const ENDPOINTS = [
  { method: 'GET', path: '/admin/status', summary: 'Return server health and stats.' },
  { method: 'GET', path: '/admin/events', summary: 'Return recent events for the dashboard.' },
  { method: 'GET', path: '/admin/rooms', summary: 'Return active rooms for the dashboard.' },
  { method: 'GET', path: '/admin/peers', summary: 'Return connected peers for the dashboard.' },
  {
    method: 'GET',
    path: '/api',
    summary: 'Discovery index: HTTP endpoints plus signaling channels.',
  },
  { method: 'GET', path: '/health', summary: 'Liveness probe for the qvc signaling backend.' },
  {
    method: 'GET',
    path: '/ice-servers',
    summary: 'WebRTC ICE servers: STUN, plus TURN if configured.',
  },
];

function version() {
  return process.env.QVC_VERSION ?? '0.1.0';
}

/**
 * CORS: any localhost port plus the production domain. The localhost entry is
 * a fully anchored regex on purpose — a wildcard like `http://localhost:*`
 * would also admit origins such as http://localhostevil.com.
 */
const CORS_DEFAULT = String.raw`^https?://(localhost|127\.0\.0\.1)(:\d+)?$,https://andypeterson.dev`;

/** A port wildcard would match only literally, locking every real origin out. */
const LEGACY_WILDCARD = /^(https?):\/\/([A-Za-z0-9.\-]+):\*$/;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseCors(raw) {
  const regexes = [];
  const exact = new Set();
  for (const item of raw.split(',')) {
    let entry = item.trim();
    if (!entry) continue;
    const legacy = LEGACY_WILDCARD.exec(entry);
    if (legacy) {
      const [, scheme, host] = legacy;
      entry = `^${scheme}://${escapeRegex(host)}(:\\d+)?$`;
      console.warn(
        `QVC_CORS_ORIGINS entry '${item.trim()}' uses the legacy port wildcard; ` +
          `matching it as the anchored regex '${entry}' instead`,
      );
    }
    if (entry.startsWith('^')) regexes.push(new RegExp(entry));
    else exact.add(entry);
  }
  return { regexes, exact };
}

/** Whether an Origin is allowed. No Origin means nothing to vet, so no. */
export function makeOriginCheck(raw) {
  const { regexes, exact } = parseCors(raw);
  return (origin) => {
    if (!origin) return false;
    return exact.has(origin) || regexes.some((rx) => rx.test(origin));
  };
}

/**
 * The secrets the front door may present, newest first. Comma-separated so the
 * gateway can move to a new value without an outage: add the new secret, switch
 * the gateway, drop the old one. Read per connection, so a changed environment
 * takes effect with no restart.
 */
function acceptedOriginSecrets() {
  return (process.env.ORIGIN_SECRET ?? '')
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean);
}

/** A length-independent constant-time compare. */
function secretsMatch(got, want) {
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) {
    // Still compare, so the answer costs the same time either way.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Whether a request carries the gateway's X-Origin-Secret. Fails closed: with
 * ORIGIN_SECRET unset nothing connects unless QVC_ALLOW_INSECURE=1, because
 * this origin is reachable from the public internet and the recruiter-pass
 * gate lives at the gateway rather than here.
 */
export function frontDoorOk(headers) {
  const want = acceptedOriginSecrets();
  if (!want.length) return process.env.QVC_ALLOW_INSECURE === '1';
  const got = headers['x-origin-secret'] ?? '';
  // Every candidate is checked: stopping at the first match would leak which
  // secret matched, and a plain !== would leak timing.
  let ok = false;
  for (const candidate of want) {
    if (secretsMatch(got, candidate)) ok = true;
  }
  return ok;
}

function trustedProxyCount() {
  const parsed = Number.parseInt(process.env.QVC_TRUSTED_PROXIES ?? '0', 10);
  return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
}

/**
 * Client IP for rate limiting. X-Forwarded-For is client-controlled up to the
 * first trusted hop, so honouring it unconditionally would let anyone mint a
 * fresh "IP" per request and sidestep the limiter entirely. With
 * QVC_TRUSTED_PROXIES=0 the header is ignored; behind N proxies, the address N
 * hops from the right is the first one a proxy actually vouched for.
 */
export function clientIp(headers, remoteAddress) {
  const trusted = trustedProxyCount();
  if (trusted > 0) {
    const hops = (headers['x-forwarded-for'] ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (hops.length >= trusted) return hops[hops.length - trusted];
  }
  return remoteAddress ?? 'unknown';
}

/** The uniform error envelope every 4xx and 5xx body carries. */
export function errorBody(code, message, details) {
  const body = { code, message };
  if (details !== undefined) body.details = details;
  return { error: body };
}

const NOT_FOUND_DESCRIPTION =
  'The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.';

export function createApp() {
  const app = express();
  const rooms = new RoomManager();
  const originAllowed = makeOriginCheck(process.env.QVC_CORS_ORIGINS ?? CORS_DEFAULT);

  // Per-IP token bucket covering connect, create and join — the abuse surface.
  // SDP and ICE relay are not throttled: they are reachable only once paired.
  const limiter = new RateLimiter(
    Number.parseInt(process.env.QVC_RATE_LIMIT ?? '30', 10),
    Number.parseFloat(process.env.QVC_RATE_WINDOW ?? '60'),
  );
  const sidIps = new Map();

  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Admin-Secret, X-Origin-Secret',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.status(204).end();
      return;
    }
    next();
  });

  /**
   * Fail-closed: without QVC_ADMIN_SECRET the admin surface 404s like a missing
   * route; with it, every /admin request must send the secret.
   */
  app.use((req, res, next) => {
    if (!req.path.startsWith('/admin')) {
      next();
      return;
    }
    const adminSecret = process.env.QVC_ADMIN_SECRET ?? '';
    const supplied = req.headers['x-admin-secret'] ?? '';
    if (!adminSecret || !secretsMatch(supplied, adminSecret)) {
      if (adminSecret && supplied) {
        // A wrong guess is an active probe: burn a token from the same per-IP
        // bucket as signaling abuse, and leave a trace.
        const ip = clientIp(req.headers, req.socket.remoteAddress);
        limiter.allow(ip);
        console.warn(`Rejected /admin request with wrong secret from ${ip}`);
      }
      // Shaped exactly like a framework 404, so the guard does not reveal that
      // the /admin surface exists at all.
      res.status(404).json(errorBody('not_found', NOT_FOUND_DESCRIPTION));
      return;
    }
    next();
  });

  /**
   * Every HTTP route but /health needs the gateway's secret, for the reason the
   * Socket.IO handshake does: this origin has a public domain and the
   * recruiter-pass gate lives at the gateway. /health is exempt because the
   * platform's own healthcheck probes it and carries no secret.
   */
  app.use((req, res, next) => {
    if (req.path === '/health' || frontDoorOk(req.headers)) {
      next();
      return;
    }
    res
      .status(403)
      .json(errorBody('needs_front_door', 'This origin is reached through the gateway.'));
  });

  app.get('/admin/status', (_req, res) => {
    res.json({
      status: 'ok',
      uptime_seconds: rooms.uptimeSeconds,
      rooms: rooms.roomCount,
      peers: rooms.peerCount,
    });
  });

  app.get('/admin/events', (req, res) => {
    const raw = req.query.limit ?? '20';
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isNaN(parsed)) {
      res.status(400).json(errorBody('bad_request', 'limit must be an integer'));
      return;
    }
    res.json({ events: rooms.getEvents(Math.max(1, Math.min(parsed, 100))) });
  });

  app.get('/admin/rooms', (_req, res) => {
    res.json({ rooms: rooms.getRoomsSummary() });
  });

  app.get('/admin/peers', (_req, res) => {
    res.json({ peers: rooms.getPeersSummary() });
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: SERVICE,
      version: version(),
      uptime_s: Math.round(rooms.uptimeSeconds * 10) / 10,
    });
  });

  app.get('/ice-servers', (_req, res) => {
    res.json({ iceServers: iceServers() });
  });

  app.get('/api', (_req, res) => {
    res.json({
      service: SERVICE,
      version: version(),
      endpoints: [...ENDPOINTS].sort(
        (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      ),
      streaming: STREAMING,
    });
  });

  app.use((req, res) => {
    const code = req.method === 'GET' ? 'not_found' : 'method_not_allowed';
    res.status(code === 'not_found' ? 404 : 405).json(errorBody(code, NOT_FOUND_DESCRIPTION));
  });

  // Express identifies the error handler by its four-argument shape, so the
  // fourth parameter stays declared even though it is never called.
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json(errorBody('internal_error', 'Internal server error.'));
  });

  return { app, rooms, limiter, sidIps, originAllowed };
}

/** Attach the Socket.IO server and its handlers to an HTTP server. */
export function attachSocketIo(httpServer, { rooms, limiter, sidIps, originAllowed }) {
  const maxBuffer = Number.parseInt(process.env.QVC_MAX_HTTP_BUFFER ?? String(64 * 1024), 10);
  const io = new SocketIoServer(httpServer, {
    // Cap inbound frames so an oversize payload cannot exhaust memory. The
    // largest real message, an SDP offer, is a few kilobytes.
    maxHttpBufferSize: maxBuffer,
    cors: {
      origin: (origin, cb) => cb(null, originAllowed(origin)),
      credentials: false,
    },
  });

  io.use((socket, next) => {
    if (!frontDoorOk(socket.handshake.headers)) {
      console.warn('Rejected a handshake with no valid front-door secret');
      next(new Error('forbidden'));
      return;
    }
    const ip = clientIp(socket.handshake.headers, socket.handshake.address);
    if (!limiter.allow(ip)) {
      console.warn('Connection rate limit exceeded');
      next(new Error('rate limited'));
      return;
    }
    sidIps.set(socket.id, ip);
    next();
  });

  io.on('connection', (socket) => {
    const sid = socket.id;
    rooms.registerPeer(sid);
    rooms.logEvent('peer_connected', { sid });
    console.log(`Peer connected: ${redact(sid)} (total: ${rooms.peerCount})`);
    socket.emit('welcome', { sid });

    const peerOf = () => {
      const room = rooms.getPeerRoom(sid);
      return { room, other: room ? room.otherPeer(sid) : null };
    };

    /** Relay `payload` to the room peer, if this peer is in a room with one. */
    const relay = (event, payload) => {
      const { other } = peerOf();
      if (other) io.to(other).emit(event, payload);
    };

    socket.on('disconnect', () => {
      sidIps.delete(sid);
      const { other } = peerOf();
      const roomId = rooms.unregisterPeer(sid);
      rooms.logEvent('peer_disconnected', { sid, room_id: roomId });
      if (other) io.to(other).emit('peer-disconnected', { room_id: roomId });
      console.log(`Peer disconnected: ${redact(sid)} (total: ${rooms.peerCount})`);
    });

    socket.on('create_room', () => {
      if (!limiter.allow(sidIps.get(sid) ?? 'unknown')) {
        socket.emit('error', { message: 'Rate limit exceeded — slow down' });
        return;
      }
      const room = rooms.createRoom(sid);
      if (!room) {
        socket.emit('error', { message: 'Cannot create room' });
        return;
      }
      rooms.logEvent('room_created', { sid, room_id: room.roomId });
      console.log(`Room created: ${redact(room.roomId)} by ${redact(sid)}`);
      socket.emit('room-created', { room_id: room.roomId });
    });

    socket.on('join_room', (data) => {
      if (!limiter.allow(sidIps.get(sid) ?? 'unknown')) {
        socket.emit('error', { message: 'Rate limit exceeded — slow down' });
        return;
      }
      const roomId = data && typeof data === 'object' ? (data.room_id ?? '') : String(data ?? '');
      const { room, reason } = rooms.joinRoom(sid, roomId);
      if (!room) {
        // Says why without echoing the attempted token, which is a credential.
        socket.emit('error', { message: JOIN_REFUSALS[reason] ?? 'Cannot join room', reason });
        return;
      }
      const other = room.otherPeer(sid);
      rooms.logEvent('peer_joined', { sid, room_id: roomId });
      console.log(`Peer ${redact(sid)} joined room ${redact(roomId)}`);
      if (other) io.to(other).emit('room-joined', { room_id: roomId, initiator: true });
      socket.emit('room-joined', { room_id: roomId, initiator: false });
    });

    socket.on('leave_room', () => {
      const { other } = peerOf();
      const roomId = rooms.leaveRoom(sid);
      rooms.logEvent('peer_left', { sid, room_id: roomId });
      if (roomId && other) io.to(other).emit('peer-disconnected', { room_id: roomId });
      console.log(`Peer ${redact(sid)} left room ${redact(roomId)}`);
    });

    socket.on('offer', (data) => {
      if (!data || typeof data !== 'object') return;
      relay('offer', { sdp: data.sdp ?? null, from: sid });
    });

    socket.on('answer', (data) => {
      if (!data || typeof data !== 'object') return;
      relay('answer', { sdp: data.sdp ?? null, from: sid });
    });

    socket.on('ice_candidate', (data) => {
      if (!data || typeof data !== 'object') return;
      relay('ice-candidate', { candidate: data.candidate ?? null, from: sid });
    });

    socket.on('request_ice_restart', () => {
      relay('request-ice-restart', {});
    });

    socket.on('eve_demo', (data) => {
      if (!data || typeof data !== 'object') return;
      // The joiner has no toggle, so this says the QBER climb is the demo the
      // other side started rather than a real attack.
      relay('eve-demo', { active: Boolean(data.active) });
    });
  });

  return io;
}
