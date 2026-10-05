/** A live server per test, on an OS-assigned port, torn down after. */
import { io as ioClient } from 'socket.io-client';
import { start } from '../../server/main.js';

const ENV_KEYS = [
  'ORIGIN_SECRET',
  'QVC_ALLOW_INSECURE',
  'QVC_ADMIN_SECRET',
  'QVC_RATE_LIMIT',
  'QVC_RATE_WINDOW',
  'QVC_TRUSTED_PROXIES',
  'QVC_CORS_ORIGINS',
  'QVC_MAX_HTTP_BUFFER',
];

export function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}

export function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Bring up a server with the front door open unless a test says otherwise. */
export async function serve(env = {}) {
  process.env.QVC_ALLOW_INSECURE ??= '1';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const running = await start({ host: '127.0.0.1', listenPort: 0 });
  running.url = `http://127.0.0.1:${String(running.port)}`;
  running.stop = () =>
    new Promise((resolve) => {
      running.io.close();
      running.server.close(() => resolve());
    });
  return running;
}

/** A connected client, resolved once the server has acknowledged it. */
export function connect(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { transports: ['websocket'], forceNew: true, ...opts });
    socket.once('welcome', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('connect timed out')), 4000);
  });
}

/** The next `event` this socket receives. */
export function next(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    socket.once(event, resolve);
    setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
  });
}

/** A pair already in the same room: [creator, joiner, roomId]. */
export async function paired(url) {
  const a = await connect(url);
  const b = await connect(url);
  a.emit('create_room');
  const { room_id: roomId } = await next(a, 'room-created');
  b.emit('join_room', { room_id: roomId });
  await next(b, 'room-joined');
  return [a, b, roomId];
}
