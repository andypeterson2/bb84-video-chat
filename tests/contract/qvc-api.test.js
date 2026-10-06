// @vitest-environment node
/**
 * Contract tests for the qvc signaling backend: the `/health` liveness body,
 * the `/api` discovery manifest, and the error envelope on every 4xx/5xx
 * response.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { restoreEnv, saveEnv, serve } from '../server/helpers.js';
import { assertMatches } from './schema.js';

const ADMIN_SECRET = 'test-admin-secret';
const ADMIN_HEADERS = { 'X-Admin-Secret': ADMIN_SECRET };
const SOURCE = new URL('../../server/app.js', import.meta.url);

let saved;
let running;

async function body(path, options) {
  const response = await fetch(running.url + path, options);
  return { status: response.status, json: await response.json() };
}

beforeEach(async () => {
  saved = saveEnv();
  running = await serve({ QVC_ADMIN_SECRET: ADMIN_SECRET });
});

afterEach(async () => {
  await running.stop();
  restoreEnv(saved);
});

describe('contract surface', () => {
  it('serves a health body matching the schema', async () => {
    const { status, json } = await body('/health');
    expect(status).toBe(200);
    assertMatches('health', json);
    expect(json.service).toBe('qvc');
  });

  it('serves a discovery manifest matching the schema', async () => {
    const { status, json } = await body('/api');
    expect(status).toBe(200);
    assertMatches('manifest', json);
    expect(json.service).toBe('qvc');
  });

  it('lists every http route in the manifest', async () => {
    // The curl-able rule: every operation appears in the manifest.
    const { json } = await body('/api');
    const listed = new Set(json.endpoints.map((e) => `${e.method} ${e.path}`));
    const actual = new Set();
    for (const layer of running.app.router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === 'head' || method === 'options') continue;
        actual.add(`${method.toUpperCase()} ${layer.route.path}`);
      }
    }
    const missing = [...actual].filter((route) => !listed.has(route)).sort();
    expect(missing, `routes missing from /api: ${missing.join(', ')}`).toEqual([]);
  });

  it('names every emitted event in the manifest streaming list', async () => {
    // Socket.IO events are not in the route table, so STREAMING lists them by
    // hand — and must not fall behind what the server actually emits.
    const { json } = await body('/api');
    const listed = new Set(json.streaming.filter((s) => s.event).map((s) => s.event));
    const source = readFileSync(SOURCE, 'utf8');
    // Both forms the server emits through: a direct `.emit('name'` and the
    // room-peer `relay('name'` helper, which emits its first argument.
    const emitted = [...source.matchAll(/(?:\.emit|relay)\('([^']+)'/g)].map((m) => m[1]);
    const undocumented = [...new Set(emitted.filter((event) => !listed.has(event)))].sort();
    expect(undocumented, `emitted but undocumented: ${undocumented.join(', ')}`).toEqual([]);
  });
});

describe('error envelope', () => {
  it('shapes a not-found like the schema', async () => {
    const { status, json } = await body('/__contract_missing__');
    expect(status).toBe(404);
    assertMatches('error', json);
    expect(json.error.code).toBe('not_found');
  });

  it('shapes a method-not-allowed like the schema', async () => {
    const { status, json } = await body('/health', { method: 'POST' });
    expect(status).toBe(405);
    assertMatches('error', json);
    expect(json.error.code).toBe('method_not_allowed');
  });

  it('shapes a bad admin events limit like the schema', async () => {
    // The regression: this returned {"error": "<string>"}, which the schema
    // rejects — `error` must be an object carrying `code` and `message`.
    const { status, json } = await body('/admin/events?limit=abc', { headers: ADMIN_HEADERS });
    expect(status).toBe(400);
    assertMatches('error', json);
    expect(json.error.code).toBe('bad_request');
  });

  it('shapes the fail-closed admin 404 like the schema', async () => {
    // The admin guard shapes its refusal as a 404; that body is an error
    // response too, so it must carry the envelope like any other.
    await running.stop();
    restoreEnv(saved);
    saved = saveEnv();
    delete process.env.QVC_ADMIN_SECRET;
    running = await serve();
    const { status, json } = await body('/admin/status');
    expect(status).toBe(404);
    assertMatches('error', json);
    expect(json.error.code).toBe('not_found');
  });
});
