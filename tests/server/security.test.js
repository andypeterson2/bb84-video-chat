// @vitest-environment node
/** The guards, asserted on behaviour: front door, admin, CORS, rate limiting. */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { makeOriginCheck, frontDoorOk, clientIp } from '../../server/app.js';
import { RateLimiter } from '../../server/throttle.js';
import { serve, connect, saveEnv, restoreEnv } from './helpers.js';

let env;
let running = null;

beforeEach(() => {
  env = saveEnv();
});

afterEach(async () => {
  if (running) await running.stop();
  running = null;
  restoreEnv(env);
});

describe('the front door', () => {
  test('refuses when no secret is configured, unless development opts out', () => {
    delete process.env.ORIGIN_SECRET;
    delete process.env.QVC_ALLOW_INSECURE;
    expect(frontDoorOk({})).toBe(false);
  });

  test('an explicit opt-out lets a local run through', () => {
    delete process.env.ORIGIN_SECRET;
    process.env.QVC_ALLOW_INSECURE = '1';
    expect(frontDoorOk({})).toBe(true);
  });

  test('a matching secret passes', () => {
    process.env.ORIGIN_SECRET = 'top-secret';
    expect(frontDoorOk({ 'x-origin-secret': 'top-secret' })).toBe(true);
  });

  test('a wrong or missing secret fails', () => {
    process.env.ORIGIN_SECRET = 'top-secret';
    expect(frontDoorOk({ 'x-origin-secret': 'guess' })).toBe(false);
    expect(frontDoorOk({})).toBe(false);
  });

  test('rotation accepts either value, so the gateway can move without an outage', () => {
    process.env.ORIGIN_SECRET = 'new-one, old-one';
    expect(frontDoorOk({ 'x-origin-secret': 'new-one' })).toBe(true);
    expect(frontDoorOk({ 'x-origin-secret': 'old-one' })).toBe(true);
    expect(frontDoorOk({ 'x-origin-secret': 'third' })).toBe(false);
  });

  test('an insecure opt-out does not override a configured secret', () => {
    process.env.ORIGIN_SECRET = 'top-secret';
    process.env.QVC_ALLOW_INSECURE = '1';
    expect(frontDoorOk({})).toBe(false);
  });

  test('a secret of a different length is refused rather than throwing', () => {
    process.env.ORIGIN_SECRET = 'top-secret';
    expect(frontDoorOk({ 'x-origin-secret': 'much-much-longer-guess' })).toBe(false);
  });

  test('health stays open for the platform probe', async () => {
    running = await serve({ ORIGIN_SECRET: 'shh', QVC_ALLOW_INSECURE: '' });
    const res = await fetch(`${running.url}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).service).toBe('qvc');
  });

  test('ice-servers needs the secret', async () => {
    running = await serve({ ORIGIN_SECRET: 'shh', QVC_ALLOW_INSECURE: '' });
    expect((await fetch(`${running.url}/ice-servers`)).status).toBe(403);
    const ok = await fetch(`${running.url}/ice-servers`, { headers: { 'X-Origin-Secret': 'shh' } });
    expect(ok.status).toBe(200);
  });

  test('discovery needs the secret', async () => {
    running = await serve({ ORIGIN_SECRET: 'shh', QVC_ALLOW_INSECURE: '' });
    expect((await fetch(`${running.url}/api`)).status).toBe(403);
  });

  test('the refusal uses the error envelope', async () => {
    running = await serve({ ORIGIN_SECRET: 'shh', QVC_ALLOW_INSECURE: '' });
    const body = await (await fetch(`${running.url}/api`)).json();
    expect(body.error.code).toBe('needs_front_door');
    expect(typeof body.error.message).toBe('string');
  });

  test('a handshake without the secret is refused', async () => {
    running = await serve({ ORIGIN_SECRET: 'shh', QVC_ALLOW_INSECURE: '' });
    await expect(connect(running.url)).rejects.toThrow();
  });
});

describe('the admin surface', () => {
  test('is absent entirely when no secret is set', async () => {
    running = await serve({ QVC_ADMIN_SECRET: '' });
    const res = await fetch(`${running.url}/admin/status`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  test('refuses a request with no header', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    expect((await fetch(`${running.url}/admin/status`)).status).toBe(404);
  });

  test('refuses a wrong secret', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    const res = await fetch(`${running.url}/admin/status`, {
      headers: { 'X-Admin-Secret': 'guess' },
    });
    expect(res.status).toBe(404);
  });

  test('accepts the right secret', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    const res = await fetch(`${running.url}/admin/status`, {
      headers: { 'X-Admin-Secret': 'letmein' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });

  test('a non-ASCII header is refused rather than crashing the guard', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    const res = await fetch(`${running.url}/admin/status`, {
      headers: { 'X-Admin-Secret': 'pässwörd' },
    });
    expect(res.status).toBe(404);
  });

  test('the refusal is shaped like a real 404, so it reveals no admin surface', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    const guarded = await fetch(`${running.url}/admin/status`);
    const missing = await fetch(`${running.url}/no-such-route`);
    expect(guarded.status).toBe(missing.status);
    expect(await guarded.json()).toEqual(await missing.json());
  });

  test('health and discovery stay open', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    expect((await fetch(`${running.url}/health`)).status).toBe(200);
    expect((await fetch(`${running.url}/api`)).status).toBe(200);
  });

  test('a non-integer limit is rejected', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    const res = await fetch(`${running.url}/admin/events?limit=lots`, {
      headers: { 'X-Admin-Secret': 'letmein' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  test('a huge limit is clamped', async () => {
    running = await serve({ QVC_ADMIN_SECRET: 'letmein' });
    const res = await fetch(`${running.url}/admin/events?limit=99999`, {
      headers: { 'X-Admin-Secret': 'letmein' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).events.length).toBeLessThanOrEqual(100);
  });
});

describe('origin checks', () => {
  const allowed = makeOriginCheck(
    String.raw`^https?://(localhost|127\.0\.0\.1)(:\d+)?$,https://andypeterson.dev`,
  );

  test('localhost on any port, and the production domain', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:4321',
      'https://127.0.0.1:8080',
      'https://andypeterson.dev',
    ]) {
      expect(allowed(origin)).toBe(true);
    }
  });

  test('a lookalike host is refused, which an unanchored pattern would admit', () => {
    for (const origin of [
      'http://localhostevil.com',
      'https://andypeterson.dev.evil.com',
      'http://127.0.0.1.evil.com',
      'https://evil.com',
    ]) {
      expect(allowed(origin)).toBe(false);
    }
  });

  test('no Origin is not allow-listed', () => {
    expect(allowed(undefined)).toBe(false);
    expect(allowed('')).toBe(false);
  });

  test('a legacy port wildcard becomes the anchored regex, not a literal', () => {
    const check = makeOriginCheck('http://localhost:*');
    expect(check('http://localhost:3000')).toBe(true);
    expect(check('http://localhost')).toBe(true);
    expect(check('http://localhostevil.com')).toBe(false);
  });
});

describe('rate limiting', () => {
  test('allows up to the rate, then refuses', () => {
    const limiter = new RateLimiter(3, 60);
    expect([1, 2, 3].map(() => limiter.allow('ip'))).toEqual([true, true, true]);
    expect(limiter.allow('ip')).toBe(false);
  });

  test('keys are independent', () => {
    const limiter = new RateLimiter(1, 60);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
  });

  test('the bucket count is capped, so a varying key cannot grow memory', () => {
    const limiter = new RateLimiter(1, 60);
    for (let i = 0; i < 10_050; i++) limiter.allow(`ip-${String(i)}`);
    expect(limiter._buckets.size).toBeLessThanOrEqual(10_000);
  });

  test('a connection over the cap is refused', async () => {
    running = await serve({ QVC_RATE_LIMIT: '2', QVC_RATE_WINDOW: '60' });
    const first = await connect(running.url);
    const second = await connect(running.url);
    await expect(connect(running.url)).rejects.toThrow();
    first.disconnect();
    second.disconnect();
  });
});

describe('client addressing', () => {
  test('X-Forwarded-For is ignored by default, so it cannot be spoofed', () => {
    delete process.env.QVC_TRUSTED_PROXIES;
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe('10.0.0.1');
  });

  test('behind one proxy the client hop is used', () => {
    process.env.QVC_TRUSTED_PROXIES = '1';
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 10.0.0.2' }, '10.0.0.1')).toBe('10.0.0.2');
  });

  test('behind two proxies it takes the second hop from the right', () => {
    process.env.QVC_TRUSTED_PROXIES = '2';
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9, 10.0.0.2' }, '10.0.0.1')).toBe(
      '9.9.9.9',
    );
  });

  test('a chain shorter than the trusted count falls back to the socket address', () => {
    process.env.QVC_TRUSTED_PROXIES = '3';
    expect(clientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('what the server declines to say', () => {
  test('a failed join does not echo the attempted token back', async () => {
    running = await serve();
    const socket = await connect(running.url);
    const failure = new Promise((resolve) => socket.once('error', resolve));
    socket.emit('join_room', { room_id: 'a-token-someone-guessed' });
    const payload = await failure;
    expect(JSON.stringify(payload)).not.toContain('a-token-someone-guessed');
    socket.disconnect();
  });
});
