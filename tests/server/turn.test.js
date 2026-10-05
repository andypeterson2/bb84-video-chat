// @vitest-environment node
/** TURN credential minting and the ICE list the browser is handed. */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { turnCredential, iceServers } from '../../server/turn.js';

const ENV_KEYS = ['QVC_TURN_SECRET', 'QVC_TURN_URLS', 'QVC_STUN_URLS', 'QVC_TURN_TTL'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('turnCredential', () => {
  test('the username carries the absolute expiry, so coturn needs no shared state', () => {
    const cred = turnCredential('s3cret', ['turn:example:3478'], 600, 1_000_000);
    const [expiry, nonce] = cred.username.split(':');
    expect(Number(expiry)).toBe(1_000_600);
    expect(nonce).toMatch(/^[0-9a-f]{16}$/);
  });

  test('the credential is the HMAC coturn recomputes', () => {
    const cred = turnCredential('s3cret', ['turn:example:3478'], 600, 1_000_000);
    const expected = createHmac('sha1', 's3cret').update(cred.username).digest('base64');
    expect(cred.credential).toBe(expected);
  });

  test('the shared secret never appears in the result', () => {
    const cred = turnCredential('s3cret', ['turn:example:3478'], 600, 1_000_000);
    expect(JSON.stringify(cred)).not.toContain('s3cret');
  });

  test('a fresh nonce each time, so two credentials never collide', () => {
    const a = turnCredential('s', ['turn:x'], 60, 1000);
    const b = turnCredential('s', ['turn:x'], 60, 1000);
    expect(a.username).not.toBe(b.username);
  });

  test('the urls are carried through', () => {
    const cred = turnCredential('s', ['turn:a:3478', 'turns:b:5349'], 60, 0);
    expect(cred.urls).toEqual(['turn:a:3478', 'turns:b:5349']);
  });
});

describe('iceServers', () => {
  test('STUN defaults when nothing is configured', () => {
    const servers = iceServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].urls[0]).toMatch(/^stun:/);
  });

  test('STUN urls are overridable', () => {
    process.env.QVC_STUN_URLS = 'stun:one:3478, stun:two:3478';
    expect(iceServers()[0].urls).toEqual(['stun:one:3478', 'stun:two:3478']);
  });

  test('TURN is appended only when both secret and urls are set', () => {
    process.env.QVC_TURN_SECRET = 'shh';
    expect(iceServers()).toHaveLength(1);
    process.env.QVC_TURN_URLS = 'turn:relay:3478';
    const servers = iceServers();
    expect(servers).toHaveLength(2);
    expect(servers[1]).toHaveProperty('credential');
  });

  test('a configured secret alone degrades to STUN rather than erroring', () => {
    process.env.QVC_TURN_URLS = 'turn:relay:3478';
    expect(iceServers()).toHaveLength(1);
  });

  test('the TTL is floored, so a silly value cannot mint a dead credential', () => {
    process.env.QVC_TURN_SECRET = 'shh';
    process.env.QVC_TURN_URLS = 'turn:relay:3478';
    process.env.QVC_TURN_TTL = '1';
    const [, turn] = iceServers(1000);
    expect(Number(turn.username.split(':')[0])).toBe(1060);
  });

  test('a non-numeric TTL falls back rather than throwing', () => {
    process.env.QVC_TURN_SECRET = 'shh';
    process.env.QVC_TURN_URLS = 'turn:relay:3478';
    process.env.QVC_TURN_TTL = 'soon';
    const [, turn] = iceServers(0);
    expect(Number(turn.username.split(':')[0])).toBe(3600);
  });
});
