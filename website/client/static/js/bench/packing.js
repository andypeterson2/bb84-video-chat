/**
 * Bit-packing and sparse-index codecs for frame-based key exchange.
 *
 * At bench scale (10^5 slots per frame) the old positional JSON arrays are
 * 400 KB+ per message; packed bits and delta-varint index sets keep every
 * peer/daemon message a few KB. All packing is MSB-first within a byte,
 * matching the existing key serialization in the distillation code.
 */

/** Pack an array of 0/1 values into bytes (MSB-first). */
export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  return bytes;
}

/**
 * Unpack `n` bits from bytes (MSB-first).
 * @returns {Uint8Array} 0/1 per entry
 */
export function unpackBits(bytes, n) {
  const bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    bits[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  return bits;
}

/**
 * Encode a strictly-increasing index list as delta-varints (LEB128).
 * Detection indices are sparse and ordered, so deltas are small and the
 * whole set compresses to ~1-2 bytes per detection.
 */
export function encodeIndices(indices) {
  const out = [];
  let prev = -1;
  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx <= prev) {
      throw new Error('encodeIndices requires strictly-increasing non-negative integers');
    }
    let delta = idx - prev;
    prev = idx;
    while (delta >= 0x80) {
      out.push((delta & 0x7f) | 0x80);
      delta >>>= 7;
    }
    out.push(delta);
  }
  return Uint8Array.from(out);
}

/** Decode a delta-varint index list. @returns {Uint32Array} */
export function decodeIndices(bytes) {
  const indices = [];
  let prev = -1;
  let i = 0;
  while (i < bytes.length) {
    let delta = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length || shift > 28) throw new Error('malformed varint index stream');
      const b = bytes[i++];
      delta |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (delta <= 0) throw new Error('malformed varint index stream: non-positive delta');
    prev += delta;
    indices.push(prev);
  }
  return Uint32Array.from(indices);
}

/** Uint8Array → base64 (chunked to dodge argument-count limits). */
export function toB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → Uint8Array; returns null on malformed input (peer data). */
export function fromB64(b64) {
  if (typeof b64 !== 'string') return null;
  try {
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Crypto-grade random bits (0/1 per entry). Feeds the source's raw key bits,
 * basis choices, sample positions, and the Toeplitz seed — everything whose
 * predictability would hand Eve the key.
 */
export function randomBits(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Uint8Array.from(bytes, (b) => b & 1);
}

/** Pack bits (0/1 array) into bytes for the final key. */
export function bitsToBytes(bits) {
  return packBits(bits);
}
