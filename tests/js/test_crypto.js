// @vitest-environment node

/**
 * SFrame-aligned frame crypto (RFC 9605): epoch derivation, deterministic
 * counter nonce, AAD-bound header, and the seal/open round-trip that the
 * Insertable-Streams worker uses in production. Runs under Node's webcrypto.
 */
import { webcrypto } from 'node:crypto';
import {
  deriveEpoch,
  sealFrame,
  openFrame,
  encodeHeader,
  decodeHeader,
  nonceFor,
  EpochMissingError,
} from '../../website/client/static/js/crypto.js';

const subtle = webcrypto.subtle;
const rawKey = new Uint8Array(16).fill(7);

describe('SFrame header codec', () => {
  test('round-trips KID and CTR across sizes, plus the keyframe bit', () => {
    // KIDs either side of the inline limit (7), CTRs of 1, 2 and 4 bytes.
    for (const [kid, ctr, isKey] of [
      [0, 0, false],
      [7, 1, true],
      [8, 255, false],
      [1000, 300, true],
      [3, 16_777_216, false],
    ]) {
      const h = encodeHeader(kid, ctr, isKey);
      const d = decodeHeader(h);
      expect(d).toMatchObject({ kid, ctr, isKey, headerLen: h.length });
    }
  });

  test('a buffer too short to hold a header decodes to null', () => {
    expect(decodeHeader(new Uint8Array(0))).toBeNull();
    expect(decodeHeader(new Uint8Array(1))).toBeNull();
  });

  test('nonce is the salt XOR the counter (differs per CTR)', () => {
    const salt = new Uint8Array(12).fill(0xaa);
    expect(nonceFor(salt, 0)).toEqual(salt);
    expect(nonceFor(salt, 1)).not.toEqual(nonceFor(salt, 2));
  });
});

describe('epoch derivation', () => {
  test('is deterministic: same secret ⇒ same salt and interoperable key', async () => {
    const a = await deriveEpoch(rawKey, subtle);
    const b = await deriveEpoch(rawKey, subtle);
    expect(a.salt).toEqual(b.salt);
    // Sealed under a, opened under b (same derived key) ⇒ same key material.
    const data = new Uint8Array([9, 8, 7]).buffer;
    const sealed = await sealFrame(data, a, { kid: 0, ctr: 0, isKey: false }, subtle);
    const opened = await openFrame(sealed, () => b, subtle);
    expect(new Uint8Array(opened.plaintext)).toEqual(new Uint8Array(data));
  });

  test('a different secret derives a different, non-interoperable epoch', async () => {
    const a = await deriveEpoch(rawKey, subtle);
    const other = await deriveEpoch(new Uint8Array(16).fill(0xff), subtle);
    expect(a.salt).not.toEqual(other.salt);
    const sealed = await sealFrame(
      new Uint8Array([1]).buffer,
      a,
      { kid: 0, ctr: 0, isKey: false },
      subtle,
    );
    await expect(openFrame(sealed, () => other, subtle)).rejects.toThrow();
  });
});

describe('seal / open', () => {
  let epoch;
  beforeAll(async () => {
    epoch = await deriveEpoch(rawKey, subtle);
  });

  test('round-trip preserves the frame', async () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const sealed = await sealFrame(
      original.buffer,
      epoch,
      { kid: 0, ctr: 0, isKey: false },
      subtle,
    );
    const opened = await openFrame(sealed, () => epoch, subtle);
    expect(opened).toMatchObject({ kid: 0, ctr: 0 });
    expect(new Uint8Array(opened.plaintext)).toEqual(original);
  });

  test('the counter nonce makes identical plaintext seal differently per frame', async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const f0 = new Uint8Array(
      await sealFrame(data, epoch, { kid: 0, ctr: 0, isKey: false }, subtle),
    );
    const f1 = new Uint8Array(
      await sealFrame(data, epoch, { kid: 0, ctr: 1, isKey: false }, subtle),
    );
    expect(f0).not.toEqual(f1); // different CTR ⇒ different nonce ⇒ different ciphertext
    // Both still open to the same plaintext under their own counters.
    expect(new Uint8Array((await openFrame(f0.buffer, () => epoch, subtle)).plaintext)).toEqual(
      new Uint8Array(data),
    );
    expect((await openFrame(f1.buffer, () => epoch, subtle)).ctr).toBe(1);
  });

  test('a tampered header (AAD) fails to open', async () => {
    const sealed = new Uint8Array(
      await sealFrame(
        new Uint8Array([1, 2, 3]).buffer,
        epoch,
        { kid: 0, ctr: 5, isKey: false },
        subtle,
      ),
    );
    sealed[0] ^= 0x01; // flip a config bit — changes the bound AAD
    await expect(openFrame(sealed.buffer, () => epoch, subtle)).rejects.toThrow();
  });

  test('a tampered ciphertext fails to open', async () => {
    const sealed = new Uint8Array(
      await sealFrame(
        new Uint8Array([1, 2, 3]).buffer,
        epoch,
        { kid: 0, ctr: 0, isKey: false },
        subtle,
      ),
    );
    sealed[sealed.length - 1] ^= 0x01;
    await expect(openFrame(sealed.buffer, () => epoch, subtle)).rejects.toThrow();
  });

  test('an unknown KID raises EpochMissingError (not a silent pass-through)', async () => {
    const sealed = await sealFrame(
      new Uint8Array([1]).buffer,
      epoch,
      { kid: 3, ctr: 0, isKey: false },
      subtle,
    );
    await expect(openFrame(sealed, () => undefined, subtle)).rejects.toBeInstanceOf(
      EpochMissingError,
    );
  });

  test('a malformed frame opens to null (dropped, never rendered)', async () => {
    expect(await openFrame(new Uint8Array(1).buffer, () => epoch, subtle)).toBeNull();
  });

  test('rotation: two epochs coexist and open by their KID', async () => {
    const epochA = await deriveEpoch(new Uint8Array(16).fill(1), subtle);
    const epochB = await deriveEpoch(new Uint8Array(16).fill(2), subtle);
    const ring = new Map([
      [0, epochA],
      [1, epochB],
    ]);
    const a = await sealFrame(
      new Uint8Array([10]).buffer,
      epochA,
      { kid: 0, ctr: 0, isKey: false },
      subtle,
    );
    const b = await sealFrame(
      new Uint8Array([20]).buffer,
      epochB,
      { kid: 1, ctr: 0, isKey: false },
      subtle,
    );
    expect(new Uint8Array((await openFrame(a, (k) => ring.get(k), subtle)).plaintext)).toEqual(
      new Uint8Array([10]),
    );
    expect(new Uint8Array((await openFrame(b, (k) => ring.get(k), subtle)).plaintext)).toEqual(
      new Uint8Array([20]),
    );
  });

  test('large frame round-trip (simulating a video keyframe)', async () => {
    const big = new Uint8Array(50000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const sealed = await sealFrame(big.buffer, epoch, { kid: 2, ctr: 123, isKey: true }, subtle);
    const opened = await openFrame(sealed, () => epoch, subtle);
    expect(new Uint8Array(opened.plaintext)).toEqual(big);
  });
});
