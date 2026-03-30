/**
 * Crypto utilities for frame-level AES-128-GCM encryption.
 *
 * Designed to work both in a Web Worker (Insertable Streams) and
 * in Node.js tests via the Web Crypto API (or a polyfill).
 *
 * Frame format: [keyIndex:2][iv:12][ciphertext+tag]
 * - keyIndex: uint16 LE — which key was used (for rotation)
 * - iv: 12 random bytes
 * - ciphertext: AES-GCM output (includes 16-byte auth tag)
 */

/**
 * Import a raw 128-bit key for AES-GCM.
 *
 * @param {Uint8Array} rawKey - 16-byte key material.
 * @param {SubtleCrypto} [subtle] - Crypto implementation (defaults to globalThis.crypto.subtle).
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(rawKey, subtle) {
  const s = subtle || globalThis.crypto.subtle;
  return s.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt a frame with AES-128-GCM.
 *
 * @param {ArrayBuffer} plaintext - The encoded frame data.
 * @param {CryptoKey} key - AES-GCM key.
 * @param {number} keyIndex - Key rotation index (0-65535).
 * @param {SubtleCrypto} [subtle] - Crypto implementation.
 * @returns {Promise<ArrayBuffer>} Encrypted frame: keyIndex(2) + iv(12) + ciphertext.
 */
export async function encryptFrame(plaintext, key, keyIndex, subtle) {
  const s = subtle || globalThis.crypto.subtle;
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  // Ensure plaintext is a proper ArrayBuffer (not a view or detached buffer)
  const ptBuf = plaintext instanceof ArrayBuffer ? plaintext : new Uint8Array(plaintext).buffer;
  const ciphertext = await s.encrypt({ name: 'AES-GCM', iv }, key, ptBuf);

  const result = new Uint8Array(2 + 12 + ciphertext.byteLength);
  // Key index as uint16 LE
  result[0] = keyIndex & 0xff;
  result[1] = (keyIndex >> 8) & 0xff;
  result.set(iv, 2);
  result.set(new Uint8Array(ciphertext), 14);
  return result.buffer;
}

/**
 * Decrypt a frame with AES-128-GCM.
 *
 * @param {ArrayBuffer} encrypted - Frame in the format produced by encryptFrame.
 * @param {CryptoKey} key - AES-GCM key.
 * @param {SubtleCrypto} [subtle] - Crypto implementation.
 * @returns {Promise<{plaintext: ArrayBuffer, keyIndex: number}>}
 * @throws {Error} If decryption fails (wrong key, tampered data).
 */
export async function decryptFrame(encrypted, key, subtle) {
  const s = subtle || globalThis.crypto.subtle;
  const view = new Uint8Array(encrypted);
  const keyIndex = view[0] | (view[1] << 8);
  const iv = view.slice(2, 14);
  const ciphertext = view.slice(14);

  const plaintext = await s.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return { plaintext, keyIndex };
}

/**
 * Parse the key index from an encrypted frame without decrypting.
 *
 * @param {ArrayBuffer} encrypted - Encrypted frame.
 * @returns {number} Key index (0-65535).
 */
export function parseKeyIndex(encrypted) {
  const view = new Uint8Array(encrypted);
  return view[0] | (view[1] << 8);
}
