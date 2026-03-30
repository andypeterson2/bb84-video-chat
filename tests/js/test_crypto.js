// @vitest-environment node

/**
 * Tests for frame-level AES-128-GCM encryption/decryption.
 * Runs in Node environment (not jsdom) to avoid ArrayBuffer realm issues.
 */
import { webcrypto } from 'node:crypto';
import { importKey, encryptFrame, decryptFrame, parseKeyIndex } from '../../website/client/static/js/crypto.js';

describe('Frame Crypto', () => {
  let key;
  const rawKey = new Uint8Array(16); // all zeros — fine for tests

  beforeAll(async () => {
    key = await importKey(rawKey, webcrypto.subtle);
  });

  test('encrypt then decrypt round-trip preserves data', async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const encrypted = await encryptFrame(original.buffer, key, 0, webcrypto.subtle);

    // 2 (keyIdx) + 12 (iv) + 8 (data) + 16 (tag) = 38
    expect(new Uint8Array(encrypted).length).toBe(38);

    const { plaintext, keyIndex } = await decryptFrame(encrypted, key, webcrypto.subtle);
    expect(keyIndex).toBe(0);
    expect(new Uint8Array(plaintext)).toEqual(original);
  });

  test('key index is preserved through encrypt/decrypt', async () => {
    const data = new Uint8Array([10, 20, 30]);
    const encrypted = await encryptFrame(data.buffer, key, 42, webcrypto.subtle);
    const { keyIndex } = await decryptFrame(encrypted, key, webcrypto.subtle);
    expect(keyIndex).toBe(42);
  });

  test('key index can be parsed without decrypting', async () => {
    const data = new Uint8Array([1]);
    const encrypted = await encryptFrame(data.buffer, key, 1000, webcrypto.subtle);
    expect(parseKeyIndex(encrypted)).toBe(1000);
  });

  test('wrong key fails decryption', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const encrypted = await encryptFrame(data.buffer, key, 0, webcrypto.subtle);

    const wrongRawKey = new Uint8Array(16).fill(0xff);
    const wrongKey = await importKey(wrongRawKey, webcrypto.subtle);

    await expect(decryptFrame(encrypted, wrongKey, webcrypto.subtle))
      .rejects.toThrow();
  });

  test('tampered ciphertext fails decryption', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const encrypted = await encryptFrame(data.buffer, key, 0, webcrypto.subtle);

    const tampered = new Uint8Array(encrypted);
    tampered[20] ^= 0x01;

    await expect(decryptFrame(tampered.buffer, key, webcrypto.subtle))
      .rejects.toThrow();
  });

  test('large frame round-trip (simulating video frame)', async () => {
    const bigFrame = new Uint8Array(50000);
    for (let i = 0; i < bigFrame.length; i++) bigFrame[i] = i & 0xff;

    const encrypted = await encryptFrame(bigFrame.buffer, key, 7, webcrypto.subtle);
    const { plaintext, keyIndex } = await decryptFrame(encrypted, key, webcrypto.subtle);
    expect(keyIndex).toBe(7);
    expect(new Uint8Array(plaintext)).toEqual(bigFrame);
  });

  test('each encryption produces different ciphertext (random IV)', async () => {
    const data1 = new Uint8Array([1, 2, 3]);
    const data2 = new Uint8Array([1, 2, 3]);
    const enc1 = new Uint8Array(await encryptFrame(data1.buffer, key, 0, webcrypto.subtle));
    const enc2 = new Uint8Array(await encryptFrame(data2.buffer, key, 0, webcrypto.subtle));

    const iv1 = enc1.slice(2, 14);
    const iv2 = enc2.slice(2, 14);
    expect(iv1).not.toEqual(iv2);
  });
});
