/**
 * Frame-level media encryption — SFrame-aligned (RFC 9605).
 *
 * Shared by the Insertable-Streams worker and the tests, via an injectable
 * SubtleCrypto so it runs under Node too.
 *
 * Each key epoch (KID) derives an AES-GCM key and a 12-byte salt from the
 * BB84-minted secret (HKDF-SHA-256, a one-step ratchet). The per-frame nonce is
 * salt XOR a monotonic counter (CTR), and the header is bound as AES-GCM
 * additional authenticated data:
 *
 *   frame = [ config:1 | KID? | CTR ][ ciphertext+tag ]
 *
 * The counter nonce retires the random-IV birthday bound at the source, the AAD
 * closes header malleability, and the KID carries the epoch for clean rotation.
 * The exact header bit-packing is a simplified variant of the RFC's for this
 * two-party app (both ends are ours); the design follows the standard.
 */

const te = new TextEncoder();

/** Thrown by openFrame when the header's KID is not in the key ring. */
export class EpochMissingError extends Error {
  constructor(kid) {
    super(`no epoch for KID ${kid}`);
    this.name = 'EpochMissingError';
    this.kid = kid;
  }
}

/**
 * Derive one key epoch from a raw BB84-minted secret: an AES-GCM key and a
 * 12-byte salt via HKDF-SHA-256 with distinct info labels. The raw secret is
 * never used as the AES key directly; key material stays non-extractable.
 * @param {Uint8Array} rawKey
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<{key: CryptoKey, salt: Uint8Array}>}
 */
export async function deriveEpoch(rawKey, subtle) {
  const s = subtle || globalThis.crypto.subtle;
  const base = await s.importKey('raw', rawKey, 'HKDF', false, ['deriveBits']);
  const hkdf = (info, bits) =>
    s.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) },
      base,
      bits,
    );
  const [keyBits, saltBits] = await Promise.all([
    hkdf('qvc-sframe-key', 128),
    hkdf('qvc-sframe-salt', 96),
  ]);
  const key = await s.importKey('raw', keyBits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { key, salt: new Uint8Array(saltBits) };
}

/** Minimal big-endian byte length for a non-negative integer (>= 1). */
export function minBytes(n) {
  let len = 1;
  let x = Math.floor(n / 256);
  while (x > 0) {
    len++;
    x = Math.floor(x / 256);
  }
  return len;
}

/** Big-endian bytes of a non-negative integer in `len` bytes. */
export function writeUint(n, len) {
  const b = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) {
    b[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return b;
}

/** Read a big-endian unsigned integer from bytes. */
export function readUint(bytes) {
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return n;
}

/**
 * SFrame-style header: a config byte then minimal-byte KID and CTR.
 * config = [keyframe:1][ctrLen-1:3][X:1][KID or kidLen-1:3]. X=0 packs a small
 * KID (0-7) inline; X=1 gives its byte length and the KID bytes follow.
 * @returns {Uint8Array}
 */
export function encodeHeader(kid, ctr, isKey) {
  const ctrLen = minBytes(ctr);
  const ctrBytes = writeUint(ctr, ctrLen);
  let config = (isKey ? 0x80 : 0) | (((ctrLen - 1) & 0x07) << 4);
  let kidBytes = new Uint8Array(0);
  if (kid <= 7) {
    config |= kid & 0x07; // X=0, KID inline
  } else {
    const kidLen = minBytes(kid);
    kidBytes = writeUint(kid, kidLen);
    config |= 0x08 | ((kidLen - 1) & 0x07); // X=1
  }
  const header = new Uint8Array(1 + kidBytes.length + ctrBytes.length);
  header[0] = config;
  header.set(kidBytes, 1);
  header.set(ctrBytes, 1 + kidBytes.length);
  return header;
}

/**
 * Parse an SFrame-style header; null if the buffer is too short to hold one.
 * @returns {{kid: number, ctr: number, isKey: boolean, headerLen: number}|null}
 */
export function decodeHeader(view) {
  if (view.length < 2) return null; // config + at least 1 CTR byte
  const config = view[0];
  const isKey = (config & 0x80) !== 0;
  const ctrLen = ((config >> 4) & 0x07) + 1;
  const extended = (config & 0x08) !== 0;
  let off = 1;
  let kid;
  if (!extended) {
    kid = config & 0x07;
  } else {
    const kidLen = (config & 0x07) + 1;
    if (view.length < off + kidLen) return null;
    kid = readUint(view.subarray(off, off + kidLen));
    off += kidLen;
  }
  if (view.length < off + ctrLen) return null;
  const ctr = readUint(view.subarray(off, off + ctrLen));
  return { kid, ctr, isKey, headerLen: off + ctrLen };
}

/**
 * Per-frame nonce: the epoch salt XOR the 96-bit big-endian counter. Runs once
 * per frame (30-60 fps × 2 directions), so the counter is XOR'd in place from
 * the low byte up rather than materializing a second 12-byte array — identical
 * result to `salt XOR writeUint(ctr, 12)`, one allocation instead of two. The
 * salt copy stays (the epoch salt must never be mutated). `% 256` (not `& 0xff`)
 * because a counter can exceed 32 bits, where bitwise AND would truncate.
 */
export function nonceFor(salt, ctr) {
  const nonce = salt.slice(0, 12);
  let x = ctr;
  for (let i = 11; i >= 0; i--) {
    nonce[i] ^= x % 256;
    x = Math.floor(x / 256);
  }
  return nonce;
}

/**
 * Seal a frame: [header][AES-GCM(nonce = salt XOR ctr, aad = header)].
 * @param {ArrayBuffer} plaintext
 * @param {{key: CryptoKey, salt: Uint8Array}} epoch
 * @param {{kid: number, ctr: number, isKey: boolean}} hdr
 * @param {SubtleCrypto} [subtle]
 * @returns {Promise<ArrayBuffer>}
 */
export async function sealFrame(plaintext, epoch, { kid, ctr, isKey }, subtle) {
  const s = subtle || globalThis.crypto.subtle;
  const header = encodeHeader(kid, ctr, isKey);
  const nonce = nonceFor(epoch.salt, ctr);
  const ptBuf = plaintext instanceof ArrayBuffer ? plaintext : new Uint8Array(plaintext).buffer;
  const ct = await s.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header },
    epoch.key,
    ptBuf,
  );
  const out = new Uint8Array(header.length + ct.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(ct), header.length);
  return out.buffer;
}

/**
 * Open a sealed frame. `getEpoch(kid)` returns the epoch for the header's KID,
 * or a falsy value. Returns null for a malformed header (drop it); throws
 * EpochMissingError for an unknown KID and the SubtleCrypto error on an auth /
 * AAD mismatch.
 * @returns {Promise<{plaintext: ArrayBuffer, kid: number, ctr: number}|null>}
 */
export async function openFrame(encrypted, getEpoch, subtle) {
  const s = subtle || globalThis.crypto.subtle;
  const view = new Uint8Array(encrypted);
  const hdr = decodeHeader(view);
  if (!hdr) return null;
  const epoch = getEpoch(hdr.kid);
  if (!epoch) throw new EpochMissingError(hdr.kid);
  const header = view.subarray(0, hdr.headerLen);
  const ciphertext = view.subarray(hdr.headerLen);
  const nonce = nonceFor(epoch.salt, hdr.ctr);
  const plaintext = await s.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: header },
    epoch.key,
    ciphertext,
  );
  return { plaintext, kid: hdr.kid, ctr: hdr.ctr };
}
