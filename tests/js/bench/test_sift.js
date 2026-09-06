/**
 * Per-frame sparse sifting: both sides must derive identical key strings
 * from the index-set exchange, and the QBER sample must be random,
 * bounded, and removed from the key material.
 */
import {
  siftSource,
  siftDetector,
  chooseSamplePositions,
  splitSample,
  estimateQber,
  MAX_SAMPLE_SIZE,
} from '../../../website/client/static/js/bench/sift.js';
import { randomBits } from '../../../website/client/static/js/bench/packing.js';

/** Build a consistent frame: source prep + detector clicks with no noise. */
function cleanFrame(slots = 2000, detectEvery = 7) {
  const srcBits = randomBits(slots);
  const srcBases = randomBits(slots);
  const indices = [];
  const detBases = [];
  const detBits = [];
  for (let i = 0; i < slots; i += detectEvery) {
    indices.push(i);
    const b = Math.random() < 0.5 ? 0 : 1;
    detBases.push(b);
    // Matched basis reads the true bit; mismatched basis is a coin flip.
    detBits.push(b === srcBases[i] ? srcBits[i] : Math.round(Math.random()));
  }
  return { srcBits, srcBases, indices, detBases, detBits };
}

describe('sparse sifting', () => {
  test('source and detector derive equal-length, identical key strings on a clean channel', () => {
    const f = cleanFrame();
    const { keyBits, basesAtIndices } = siftSource(f.srcBits, f.srcBases, f.indices, f.detBases);
    const detKey = siftDetector(f.detBits, f.detBases, basesAtIndices);
    expect(detKey).toEqual(keyBits);
    expect(keyBits.length).toBeGreaterThan(0);
    // ~half the detections survive basis matching.
    expect(keyBits.length).toBeLessThan(f.indices.length);
  });

  test('an out-of-frame detection index is rejected', () => {
    const f = cleanFrame(100, 10);
    expect(() => siftSource(f.srcBits, f.srcBases, [50, 200], [0, 1])).toThrow(/outside frame/);
  });

  test('a bases reply of the wrong length is rejected', () => {
    const f = cleanFrame(100, 10);
    expect(() => siftDetector(f.detBits, f.detBases, [0])).toThrow(/length/);
  });
});

describe('QBER sampling', () => {
  test('positions are in range, distinct, ascending, and capped', () => {
    const positions = chooseSamplePositions(1000);
    expect(positions.length).toBeLessThanOrEqual(MAX_SAMPLE_SIZE);
    expect(new Set(positions).size).toBe(positions.length);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
    for (const p of positions) expect(p).toBeLessThan(1000);
  });

  test('positions vary between draws (crypto-random, not a fixed prefix)', () => {
    const a = chooseSamplePositions(10_000).join(',');
    const b = chooseSamplePositions(10_000).join(',');
    expect(a).not.toEqual(b);
  });

  test('sampled bits are disclosed AND removed from the key', () => {
    const keyBits = Array.from(randomBits(400));
    const positions = chooseSamplePositions(keyBits.length);
    const { sample, remaining } = splitSample(keyBits, positions);
    expect(sample.length).toBe(positions.length);
    expect(remaining.length).toBe(keyBits.length - positions.length);
    expect(sample).toEqual(positions.map((p) => keyBits[p]));
  });

  test('QBER over identical samples is zero; over inverted samples is one', () => {
    const s = [0, 1, 1, 0, 1];
    expect(estimateQber(s, [...s])).toBe(0);
    expect(
      estimateQber(
        s,
        s.map((b) => b ^ 1),
      ),
    ).toBe(1);
  });

  test('a length-mismatched response is rejected, not silently truncated', () => {
    expect(() => estimateQber([0, 1], [0])).toThrow(/mismatch/);
  });
});
