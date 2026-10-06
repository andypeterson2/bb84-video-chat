/**
 * Short-lived TURN credentials (coturn REST API / use-auth-secret).
 *
 * The signaling server mints ephemeral credentials so no long-lived secret
 * reaches the browser. coturn runs `use-auth-secret` with the same
 * `static-auth-secret`, recomputes the HMAC to validate the credential, and
 * honours the expiry embedded in the username. Scheme:
 * draft-uberti-behave-turn-rest-00 — username `<expiry_unix>:<nonce>`,
 * credential base64(HMAC-SHA1(secret, username)).
 *
 * Media stays end-to-end encrypted regardless: a relay only ever forwards the
 * DTLS-SRTP ciphertext, and the per-frame encryption sits above that.
 */
import { createHmac, randomBytes } from 'node:crypto';

const DEFAULT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const DEFAULT_TTL = 3600;
const MIN_TTL = 60;

function splitEnvList(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function stunServers() {
  const urls = splitEnvList('QVC_STUN_URLS');
  const chosen = urls.length ? urls : [...DEFAULT_STUN];
  return chosen.length ? [{ urls: chosen }] : [];
}

function ttl() {
  const parsed = Number.parseInt(process.env.QVC_TURN_TTL ?? String(DEFAULT_TTL), 10);
  if (Number.isNaN(parsed)) return DEFAULT_TTL;
  return Math.max(MIN_TTL, parsed);
}

/**
 * One ephemeral credential valid for `ttlSeconds`. The username carries the
 * absolute expiry so coturn can reject a stale credential with no shared
 * state; the shared secret never leaves this process.
 */
export function turnCredential(secret, urls, ttlSeconds, now = null) {
  const base = now === null ? Date.now() / 1000 : now;
  const expiry = Math.floor(base + ttlSeconds);
  const username = `${expiry}:${randomBytes(8).toString('hex')}`;
  const mac = createHmac('sha1', secret).update(username).digest('base64');
  return { urls: [...urls], username, credential: mac };
}

/**
 * ICE servers for a browser: STUN always, TURN when configured. TURN is
 * appended only when both QVC_TURN_SECRET and QVC_TURN_URLS are set; otherwise
 * the caller gets STUN alone, which is graceful rather than an error, since
 * calls that need no relay still work.
 */
export function iceServers(now = null) {
  const servers = stunServers();
  const secret = process.env.QVC_TURN_SECRET ?? '';
  const urls = splitEnvList('QVC_TURN_URLS');
  if (secret && urls.length) servers.push(turnCredential(secret, urls, ttl(), now));
  return servers;
}
