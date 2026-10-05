/**
 * Combined signalling + static-client server for the e2e tests.
 *
 * Serves the Socket.IO signalling app AND the browser client from one origin,
 * so Playwright can drive two browser contexts through a real call.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createApp, attachSocketIo } from '../../server/app.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const CLIENT = join(ROOT, 'website', 'client');

// The front-door guard fails closed, and the browser here reaches this server
// directly rather than through the gateway that would carry the secret.
process.env.QVC_ALLOW_INSECURE ??= '1';

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

/** Resolve a request path inside the client directory, or null if it escapes. */
function resolveAsset(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = normalize(join(CLIENT, rel));
  return full.startsWith(CLIENT) ? full : null;
}

const { app, ...context } = createApp();

const server = createServer((req, res) => {
  const full = resolveAsset(req.url ?? '/');
  if (!full) {
    res.writeHead(403).end();
    return;
  }
  stat(full).then(
    (info) => {
      if (!info.isFile()) {
        app(req, res);
        return;
      }
      const ext = full.slice(full.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': TYPES.get(ext) ?? 'application/octet-stream' });
      createReadStream(full).pipe(res);
    },
    // Not a file on disk, so it belongs to the signalling app.
    () => app(req, res),
  );
});

attachSocketIo(server, context);

const port = Number.parseInt(process.env.QVC_E2E_PORT ?? '8077', 10);
server.listen(port, '127.0.0.1', () => {
  console.log(`e2e server listening on http://127.0.0.1:${String(port)}`);
});
