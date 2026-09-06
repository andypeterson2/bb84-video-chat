/**
 * Per-frame sparse sifting and QBER estimation.
 *
 * Sifting is index-set intersection: the detector announces which slots
 * fired and its measurement basis per detection; the source replies with its
 * preparation bases at exactly those slots. Both sides keep the detections
 * where the bases agree — same ordering (ascending slot index) on both
 * sides by construction, so the sifted bit strings align positionally.
 *
 * The QBER sample uses crypto-random positions chosen by the source per
 * frame (a fixed prefix would let Eve intercept only unsampled pulses).
 * Sampled bits are disclosed and removed from the key material.
 */

import { randomBits } from './packing.js';

/** Default fraction of a frame's sifted bits sacrificed to the QBER sample. */
export const SAMPLE_FRACTION = 0.25;
/** Cap on per-frame sample size — enough for gate decisions, cheap to send. */
export const MAX_SAMPLE_SIZE = 128;

/**
 * Source side: given the frame's full preparation and the detector's
 * announcement, produce the source's sifted key bits and the bases reply.
 *
 * @param {Uint8Array} srcBits - per-slot prepared bits (unpacked, 0/1)
 * @param {Uint8Array} srcBases - per-slot preparation bases (unpacked, 0/1)
 * @param {Uint32Array|number[]} detIndices - slots that fired (ascending)
 * @param {Uint8Array} detBases - detector's basis per detection
 * @returns {{ keyBits: number[], basesAtIndices: number[] }}
 *   keyBits: source bits at basis-matched detections, detection order;
 *   basesAtIndices: source bases at every detected slot (the reply payload).
 */
export function siftSource(srcBits, srcBases, detIndices, detBases) {
  const basesAtIndices = new Array(detIndices.length);
  const keyBits = [];
  for (let k = 0; k < detIndices.length; k++) {
    const slot = detIndices[k];
    if (slot >= srcBits.length) throw new Error(`detection index ${slot} outside frame`);
    basesAtIndices[k] = srcBases[slot];
    if (srcBases[slot] === detBases[k]) keyBits.push(srcBits[slot]);
  }
  return { keyBits, basesAtIndices };
}

/**
 * Detector side: given its detections and the source's bases reply, keep the
 * measured bits where bases matched. Ordering mirrors siftSource exactly.
 *
 * @param {Uint8Array} detBits - detector's measured bit per detection
 * @param {Uint8Array} detBases - detector's basis per detection
 * @param {number[]|Uint8Array} srcBasesAtIndices - source reply, one per detection
 * @returns {number[]} sifted key bits in detection order
 */
export function siftDetector(detBits, detBases, srcBasesAtIndices) {
  if (srcBasesAtIndices.length !== detBases.length) {
    throw new Error('bases reply length does not match detection count');
  }
  const keyBits = [];
  for (let k = 0; k < detBases.length; k++) {
    if (srcBasesAtIndices[k] === detBases[k]) keyBits.push(detBits[k]);
  }
  return keyBits;
}

/**
 * Choose crypto-random distinct sample positions within a sifted string.
 * @returns {number[]} ascending positions
 */
export function chooseSamplePositions(siftedLength, fraction = SAMPLE_FRACTION) {
  const want = Math.min(MAX_SAMPLE_SIZE, Math.floor(siftedLength * fraction));
  if (want <= 0) return [];
  // Rejection-free selection: random sort keys over all positions would be
  // O(n log n); at frame scale a Floyd-style sample keeps it O(want).
  const chosen = new Set();
  const rand = new Uint32Array(want * 2);
  crypto.getRandomValues(rand);
  let r = 0;
  for (let j = siftedLength - want; j < siftedLength; j++) {
    if (r >= rand.length) {
      crypto.getRandomValues(rand);
      r = 0;
    }
    const t = rand[r++] % (j + 1);
    chosen.add(chosen.has(t) ? j : t);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Split a sifted string into (sampled values, remaining key bits).
 * @param {number[]} keyBits
 * @param {number[]} positions - ascending, from chooseSamplePositions
 */
export function splitSample(keyBits, positions) {
  const posSet = new Set(positions);
  const sample = positions.map((p) => {
    if (p < 0 || p >= keyBits.length) throw new Error(`sample position ${p} out of range`);
    return keyBits[p];
  });
  const remaining = keyBits.filter((_, i) => !posSet.has(i));
  return { sample, remaining };
}

/** Compare two equal-length sample value lists. @returns {number} QBER */
export function estimateQber(mine, theirs) {
  if (!Array.isArray(theirs) || theirs.length !== mine.length) {
    throw new Error('sample response length mismatch');
  }
  if (mine.length === 0) return 0;
  let errors = 0;
  for (let i = 0; i < mine.length; i++) {
    if ((mine[i] & 1) !== (theirs[i] & 1)) errors++;
  }
  return errors / mine.length;
}

export { randomBits };
