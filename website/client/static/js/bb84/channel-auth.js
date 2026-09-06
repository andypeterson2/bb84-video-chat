/**
 * Channel authentication for the BB84 classical channel.
 *
 * BB84's security proof assumes the classical channel is authenticated — Eve
 * may read but must not modify or inject. This module implements that layer:
 *
 *  - k_auth is derived (HKDF-SHA-256) from the join-link capability token,
 *    which both parties hold and a network MITM does not (unless the invite
 *    channel itself was compromised — see the SAS tier below).
 *  - Direction separation: each role (initiator/joiner) signs with its own
 *    derived key, so a reflected message never verifies.
 *  - Every protocol message travels as {v, seq, payload, tag} with a monotonic
 *    per-direction sequence — replay, reorder, drop and injection all fail
 *    verification and fail the round as an integrity error. Sequence spaces
 *    are per AuthenticatedClassicalChannel instance, and the orchestrator
 *    creates a fresh instance per round, so a failed round never leaves the
 *    two sides in permanently divergent sequence states.
 *  - A short authentication string (SAS) is derived from the two DTLS
 *    fingerprints alone — a pure function, identical on both sides by
 *    construction. Two users comparing the SAS on camera authenticate the
 *    media path even if the invite link leaked: a MITM terminating DTLS
 *    presents different fingerprints and the strings visibly differ.
 *
 * Trust tiers (stated in docs/THREAT_MODEL.md): authenticated if your link
 * channel was; verified if you compared the SAS.
 */

const CONTEXT_SALT = 'qvc-channel-auth-v1';
const ROLES = ['initiator', 'joiner'];

// 32 visually distinct emoji — 5 bits each, 4 shown → 20 bits, on top of the
// 6 digits (~20 bits). Chosen to avoid near-duplicates at video resolution.
const SAS_EMOJI = [
  '🐙',
  '🦊',
  '🐢',
  '🦉',
  '🐝',
  '🐳',
  '🦋',
  '🐸',
  '🌵',
  '🍄',
  '🌻',
  '🍁',
  '🍕',
  '🍩',
  '🥑',
  '🍒',
  '⚓',
  '🎈',
  '🎲',
  '🎸',
  '🚀',
  '🛸',
  '⏰',
  '🔑',
  '⭐',
  '🌙',
  '🔥',
  '❄️',
  '☂️',
  '🧲',
  '💎',
  '🧭',
];

/** A message that failed authentication — the round must abort, no retry. */
export class ChannelAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChannelAuthError';
  }
}

const te = new TextEncoder();

function toBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64) {
  try {
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

export class ChannelAuth {
  /**
   * Derive the per-direction MAC keys from the room's capability token.
   * @param {string} roomToken - the join-link capability token
   * @param {'initiator'|'joiner'} role - this side's role
   * @returns {Promise<ChannelAuth>}
   */
  static async create(roomToken, role) {
    if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
    if (!roomToken) throw new Error('roomToken required');
    const base = await crypto.subtle.importKey('raw', te.encode(roomToken), 'HKDF', false, [
      'deriveKey',
    ]);
    const derive = (info) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: te.encode(CONTEXT_SALT), info: te.encode(info) },
        base,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      );
    const other = role === 'initiator' ? 'joiner' : 'initiator';
    const [sendKey, recvKey] = await Promise.all([
      derive(`qvc-mac-${role}`),
      derive(`qvc-mac-${other}`),
    ]);
    return new ChannelAuth(role, sendKey, recvKey);
  }

  constructor(role, sendKey, recvKey) {
    this._role = role;
    this._sendKey = sendKey;
    this._recvKey = recvKey;
  }

  /** @returns {'initiator'|'joiner'} this side's role. */
  get role() {
    return this._role;
  }

  /**
   * MAC a message this side sends. `kind` domain-separates uses ('msg', 'fp').
   * @returns {Promise<string>} base64 tag
   */
  async sign(kind, seq, payload) {
    const tag = await crypto.subtle.sign(
      'HMAC',
      this._sendKey,
      te.encode(`${kind}\n${seq}\n${payload}`),
    );
    return toBase64(tag);
  }

  /** Verify a peer's MAC. @returns {Promise<boolean>} */
  async verify(kind, seq, payload, tagB64) {
    const tag = fromBase64(tagB64);
    if (!tag) return false;
    return crypto.subtle.verify(
      'HMAC',
      this._recvKey,
      tag,
      te.encode(`${kind}\n${seq}\n${payload}`),
    );
  }

  /**
   * Derive the SAS from the two DTLS fingerprints. Pure: no transcript, no
   * freezing, no per-side state — the earlier transcript-based SAS diverged
   * between the two sides the moment their processing histories differed
   * (a failed round, a dropped message), turning an honest channel into a
   * permanent "MITM" reading. Fingerprints alone are already what the SAS
   * must bind: they identify the DTLS endpoints of the media path.
   * @param {string} fpInitiator - initiator's DTLS fingerprint
   * @param {string} fpJoiner - joiner's DTLS fingerprint
   * @returns {Promise<{digits: string, emoji: string[]}>}
   */
  async sas(fpInitiator, fpJoiner) {
    const material = [`${CONTEXT_SALT}-sas`, fpInitiator, fpJoiner].join('\n');
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(material)));
    const digits = String(((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0)
      .padStart(10, '0')
      .slice(-6);
    const emoji = [d[4], d[5], d[6], d[7]].map((b) => SAS_EMOJI[b % SAS_EMOJI.length]);
    return { digits, emoji };
  }
}

/**
 * Wraps a classical channel in the {v, seq, payload, tag} envelope.
 *
 * Lives at the adapter layer so protocol.js stays protocol-only. Sequence
 * numbers are per-direction and monotonic from 0; the receive side accepts
 * exactly the next expected sequence, so replayed, reordered, or dropped
 * messages surface as a ChannelAuthError rather than being absorbed.
 *
 * One instance covers one MAC domain: the orchestrator builds a fresh one per
 * round (kind 'msg') and a one-shot one for the fingerprint exchange (kind
 * 'fp'), so sequence spaces restart at each boundary and an envelope captured
 * in one domain never verifies in another.
 */
export class AuthenticatedClassicalChannel {
  /**
   * @param {{send: Function, receive: Function}} inner - transport channel
   * @param {ChannelAuth} auth
   * @param {string} [kind] - MAC domain-separation label
   */
  constructor(inner, auth, kind = 'msg') {
    this._inner = inner;
    this._auth = auth;
    this._kind = kind;
    this._sendSeq = 0;
    this._recvSeq = 0;
  }

  async send(data) {
    const payload = JSON.stringify(data);
    const seq = this._sendSeq++;
    const tag = await this._auth.sign(this._kind, seq, payload);
    await this._inner.send({ v: 1, seq, payload, tag });
  }

  async receive() {
    const env = await this._inner.receive();
    if (
      !env ||
      typeof env !== 'object' ||
      env.v !== 1 ||
      typeof env.payload !== 'string' ||
      typeof env.tag !== 'string' ||
      !Number.isInteger(env.seq)
    ) {
      throw new ChannelAuthError('malformed authenticated envelope');
    }
    if (env.seq !== this._recvSeq) {
      throw new ChannelAuthError(`sequence violation: expected ${this._recvSeq}, got ${env.seq}`);
    }
    const ok = await this._auth.verify(this._kind, env.seq, env.payload, env.tag);
    if (!ok) throw new ChannelAuthError('MAC verification failed');
    this._recvSeq++;
    try {
      return JSON.parse(env.payload);
    } catch {
      throw new ChannelAuthError('authenticated payload is not valid JSON');
    }
  }
}
