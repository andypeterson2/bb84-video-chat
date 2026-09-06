/**
 * e2e process orchestrator (started as Playwright's webServer).
 *
 * Brings up, in order: the detector daemon (which listens on the fiber), the
 * source daemon (which dials it), and the combined signaling+static server.
 * Each daemon writes its one-time pairing token to a file the spec reads.
 * On exit it tears every child down.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = join(here, '.artifacts');
rmSync(artifacts, { recursive: true, force: true });
mkdirSync(artifacts, { recursive: true });

const PY = process.env.QVC_PYTHON || 'python3';
const children = [];

function run(name, args, env = {}) {
  const child = spawn(args[0], args.slice(1), {
    cwd: join(here, '..', '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  children.push(child);
  return child;
}

function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} not up in time`));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  run('detector', [
    PY,
    '-m',
    'bench',
    '--config',
    join(here, 'bench-detector.toml'),
    '--pairing-token-file',
    join(artifacts, 'detector.token'),
  ]);
  await waitForPort(8781); // detector WS up ⇒ fiber listener up

  run('source', [
    PY,
    '-m',
    'bench',
    '--config',
    join(here, 'bench-source.toml'),
    '--pairing-token-file',
    join(artifacts, 'source.token'),
  ]);
  await waitForPort(8782);

  run('serve', [PY, join(here, 'serve.py')], { QVC_E2E_PORT: '8077' });
  await waitForPort(8077);
  console.log('[launch] all services up');
})().catch((err) => {
  console.error('[launch] setup failed:', err);
  shutdown();
  process.exit(1);
});
