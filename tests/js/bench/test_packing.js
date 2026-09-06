/**
 * Codecs under the frame protocol: bit packing and sparse index encoding.
 * Every peer/daemon message rides these, so round-trip fidelity is the
 * difference between a key and garbage.
 */
import {
  packBits,
  unpackBits,
  encodeIndices,
  decodeIndices,
  toB64,
  fromB64,
  randomBits,
} from '../../../website/client/static/js/bench/packing.js';

describe('bit packing', () => {
  test('round-trips arbitrary bit strings, MSB-first', () => {
    const bits = [1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 1];
    const packed = packBits(bits);
    expect(packed).toEqual(Uint8Array.from([0b10110010, 0b11100000]));
    expect(Array.from(unpackBits(packed, bits.length))).toEqual(bits);
  });

  test('round-trips random large strings', () => {
    const bits = Array.from(randomBits(10_007));
    expect(Array.from(unpackBits(packBits(bits), bits.length))).toEqual(bits);
  });

  test('empty input packs to empty output', () => {
    expect(packBits([])).toHaveLength(0);
    expect(unpackBits(new Uint8Array(0), 0)).toHaveLength(0);
  });
});

describe('sparse index codec', () => {
  test('round-trips ascending index sets', () => {
    const indices = [0, 1, 7, 128, 129, 100_000, 1_000_000];
    expect(Array.from(decodeIndices(encodeIndices(indices)))).toEqual(indices);
  });

  test('compresses realistic detection sets to ~1-2 bytes per index', () => {
    // ~1% detection over 1e5 slots — the bench-scale case the codec exists for.
    const indices = [];
    for (let i = 0; i < 100_000; i += 1) {
      if (i % 97 === 0) indices.push(i);
    }
    const encoded = encodeIndices(indices);
    expect(encoded.length).toBeLessThan(indices.length * 2);
    expect(Array.from(decodeIndices(encoded))).toEqual(indices);
  });

  test('rejects non-increasing input', () => {
    expect(() => encodeIndices([3, 3])).toThrow(/strictly-increasing/);
    expect(() => encodeIndices([5, 2])).toThrow(/strictly-increasing/);
  });

  test('rejects malformed varint streams', () => {
    expect(() => decodeIndices(Uint8Array.from([0x80]))).toThrow(/malformed/);
    expect(() => decodeIndices(Uint8Array.from([0x00]))).toThrow(/malformed/);
  });
});

describe('base64', () => {
  test('round-trips binary payloads larger than one chunk', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    expect(fromB64(toB64(bytes))).toEqual(bytes);
  });

  test('malformed input yields null, not an exception', () => {
    expect(fromB64('%%%not-base64%%%')).toBeNull();
    expect(fromB64(null)).toBeNull();
    expect(fromB64(42)).toBeNull();
  });
});
