/** Entry point: bring up the signaling server and serve it. */
import { createServer } from 'node:http';
import { createApp, attachSocketIo } from './app.js';

function port() {
  // PORT is what a PaaS assigns; QVC_SERVER_REST_PORT wins so a local run can
  // pin one. Falling through to 0 lets the OS choose.
  const pinned = Number.parseInt(process.env.QVC_SERVER_REST_PORT ?? '', 10);
  if (!Number.isNaN(pinned) && pinned > 0) return pinned;
  const assigned = Number.parseInt(process.env.PORT ?? '', 10);
  if (!Number.isNaN(assigned) && assigned > 0) return assigned;
  return 0;
}

export function start({ host = process.env.QVC_HOST ?? '127.0.0.1', listenPort = port() } = {}) {
  const context = createApp();
  const server = createServer(context.app);
  const io = attachSocketIo(server, context);
  return new Promise((resolve) => {
    server.listen(listenPort, host, () => {
      const address = server.address();
      console.log(`Signaling server starting on ${host}:${String(address.port)}`);
      resolve({ server, io, ...context, port: address.port });
    });
  });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const running = await start();
  const shutdown = (signal) => {
    console.log(`Shutting down (${signal})...`);
    running.io.close();
    running.server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
