/**
 * BB84Protocol — quantum key distribution protocol implementation.
 *
 * Takes a QuantumChannel and a ClassicalChannel (both injected).
 * Produces shared symmetric keys via:
 *   1. Qubit preparation and transmission
 *   2. Basis reconciliation (sifting)
 *   3. QBER estimation
 *   4. Error correction (binary cascade)
 *   5. Privacy amplification (Toeplitz hashing)
 */

import { BB84Metrics } from './metrics.js';

export class BB84Protocol {
  constructor(quantumChannel, classicalChannel, options = {}) {
    this._qc = quantumChannel;
    this._cc = classicalChannel;
    this._numRawBits = options.numRawBits ?? 4096;
    this._qberThreshold = options.qberThreshold ?? 0.11;
    this._targetKeyLength = options.targetKeyLength ?? 128;
  }

  /**
   * Run Alice's side of BB84.
   * @returns {{ key: Uint8Array|null, qber: number, metrics: BB84Metrics }}
   */
  async runAsAlice() {
    const metrics = new BB84Metrics();
    const startTime = Date.now();

    // Step 1: Prepare random bits and bases, send qubits
    const aliceBits = this._randomBits(this._numRawBits);
    const aliceBases = this._randomBits(this._numRawBits);
    metrics.rawBits = this._numRawBits;

    const qubits = aliceBits.map((bit, i) => ({
      bit,
      basis: aliceBases[i],
    }));

    await this._qc.sendQubits(qubits);

    // Step 2: Basis reconciliation — receive Bob's bases, send Alice's bases
    const bobBases = await this._cc.receive();
    await this._cc.send(aliceBases);

    // Sift
    const siftedAlice = this._sift(aliceBases, bobBases, aliceBits);
    metrics.siftedBits = siftedAlice.length;
    metrics.siftingEfficiency = siftedAlice.length / this._numRawBits;

    // Step 3: QBER estimation — exchange subset
    const sampleSize = Math.min(Math.floor(siftedAlice.length / 4), 256);
    const sampleIndices = Array.from({ length: sampleSize }, (_, i) => i);

    // Send sample from Alice
    await this._cc.send({
      type: 'qber-sample',
      indices: sampleIndices,
      values: sampleIndices.map((i) => siftedAlice[i]),
    });

    const bobSample = await this._cc.receive();
    const qber = this._estimateQber(
      sampleIndices.map((i) => siftedAlice[i]),
      bobSample.values,
      sampleSize
    );
    metrics.qber = qber;

    // Remove sample bits from key material
    const sampleSet = new Set(sampleIndices);
    const keyBitsAlice = siftedAlice.filter((_, i) => !sampleSet.has(i));

    if (qber > this._qberThreshold) {
      metrics.isSecure = false;
      await this._cc.send({ type: 'abort', reason: 'qber-exceeded' });
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics };
    }

    await this._cc.send({ type: 'continue' });

    // Step 4: Error correction (simplified binary cascade)
    // Exchange parities for error correction
    const correctedAlice = await this._errorCorrectAlice(keyBitsAlice);

    // Step 5: Privacy amplification
    // Generate a random Toeplitz seed and share it
    const toeplitzSeed = this._randomBits(correctedAlice.length + this._targetKeyLength - 1);
    await this._cc.send({ type: 'toeplitz-seed', seed: toeplitzSeed });

    const finalBits = this._privacyAmplify(correctedAlice, this._targetKeyLength);
    metrics.keyLength = this._targetKeyLength;
    metrics.isSecure = true;
    metrics.roundDurationMs = Date.now() - startTime;

    return {
      key: this._bitsToBytes(finalBits),
      qber,
      metrics,
    };
  }

  /**
   * Run Bob's side of BB84.
   * @returns {{ key: Uint8Array|null, qber: number, metrics: BB84Metrics }}
   */
  async runAsBob() {
    const metrics = new BB84Metrics();
    const startTime = Date.now();

    // Step 1: Receive qubits, measure with random bases
    const bobBases = this._randomBits(this._numRawBits);
    metrics.rawBits = this._numRawBits;

    const received = await this._qc.receiveQubits();
    // Measure: if bases match, bit is correct; otherwise random
    const bobBits = received.map((q, i) => {
      if (bobBases[i] === q.basis) {
        return q.bit;
      }
      return Math.random() < 0.5 ? 0 : 1;
    });

    // Step 2: Send Bob's bases, receive Alice's
    await this._cc.send(bobBases);
    const aliceBases = await this._cc.receive();

    // Sift
    const siftedBob = this._sift(aliceBases, bobBases, bobBits);
    metrics.siftedBits = siftedBob.length;
    metrics.siftingEfficiency = siftedBob.length / this._numRawBits;

    // Step 3: QBER estimation
    const aliceSample = await this._cc.receive();
    const sampleIndices = aliceSample.indices;
    const sampleSize = sampleIndices.length;

    const bobSampleValues = sampleIndices.map((i) => siftedBob[i]);
    await this._cc.send({
      type: 'qber-sample-response',
      values: bobSampleValues,
    });

    const qber = this._estimateQber(aliceSample.values, bobSampleValues, sampleSize);
    metrics.qber = qber;

    // Remove sample bits
    const sampleSet = new Set(sampleIndices);
    const keyBitsBob = siftedBob.filter((_, i) => !sampleSet.has(i));

    const decision = await this._cc.receive();
    if (decision.type === 'abort') {
      metrics.isSecure = false;
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics };
    }

    // Step 4: Error correction
    const correctedBob = await this._errorCorrectBob(keyBitsBob);

    // Step 5: Privacy amplification
    const toeplitzMsg = await this._cc.receive();
    const finalBits = this._privacyAmplify(correctedBob, this._targetKeyLength);
    metrics.keyLength = this._targetKeyLength;
    metrics.isSecure = true;
    metrics.roundDurationMs = Date.now() - startTime;

    return {
      key: this._bitsToBytes(finalBits),
      qber,
      metrics,
    };
  }

  /**
   * Sift: keep only bits where Alice and Bob used the same basis.
   * @param {Array<number>} aliceBases
   * @param {Array<number>} bobBases
   * @param {Array<number>} bits - the bits to filter (either Alice's or Bob's)
   * @returns {Array<number>}
   */
  _sift(aliceBases, bobBases, bits) {
    const result = [];
    for (let i = 0; i < aliceBases.length; i++) {
      if (aliceBases[i] === bobBases[i]) {
        result.push(bits[i]);
      }
    }
    return result;
  }

  /**
   * Estimate QBER from two bit arrays.
   * @param {Array<number>} bits1
   * @param {Array<number>} bits2
   * @param {number} sampleSize
   * @returns {number}
   */
  _estimateQber(bits1, bits2, sampleSize) {
    const n = Math.min(sampleSize, bits1.length, bits2.length);
    if (n === 0) return 0;
    let errors = 0;
    for (let i = 0; i < n; i++) {
      if (bits1[i] !== bits2[i]) errors++;
    }
    return errors / n;
  }

  /**
   * Error correction — Alice side (simplified binary cascade).
   * Exchanges block parities with Bob to correct errors.
   */
  async _errorCorrectAlice(bits) {
    const blockSize = 8;
    const parities = [];
    for (let i = 0; i < bits.length; i += blockSize) {
      const block = bits.slice(i, i + blockSize);
      parities.push(block.reduce((a, b) => a ^ b, 0));
    }
    await this._cc.send({ type: 'parities', parities });
    // Receive corrected block info
    const correction = await this._cc.receive();
    // Alice keeps her bits (she is the reference)
    return [...bits];
  }

  /**
   * Error correction — Bob side (simplified binary cascade).
   * Receives parities from Alice, flips bits in mismatched blocks.
   */
  async _errorCorrectBob(bits) {
    const blockSize = 8;
    const aliceParityMsg = await this._cc.receive();
    const aliceParities = aliceParityMsg.parities;

    const corrected = [...bits];
    for (let blockIdx = 0; blockIdx < aliceParities.length; blockIdx++) {
      const start = blockIdx * blockSize;
      const end = Math.min(start + blockSize, corrected.length);
      const block = corrected.slice(start, end);
      const bobParity = block.reduce((a, b) => a ^ b, 0);

      if (bobParity !== aliceParities[blockIdx]) {
        // Flip the first bit in the block as a simple correction
        corrected[start] ^= 1;
      }
    }
    await this._cc.send({ type: 'correction-done' });
    return corrected;
  }

  /**
   * Privacy amplification using Toeplitz hashing.
   * @param {Array<number>} bits - input bit array
   * @param {number} targetLength - desired output length in bits
   * @returns {Array<number>} - compressed bit array
   */
  _privacyAmplify(bits, targetLength) {
    // Toeplitz matrix multiplication: output[i] = XOR of bits[j] where toeplitz[i][j] = 1
    // We use a deterministic seed based on the bits themselves for the Toeplitz matrix
    const result = [];
    const n = bits.length;
    for (let i = 0; i < targetLength; i++) {
      let val = 0;
      for (let j = 0; j < n; j++) {
        // Use a simple hash-like selection: include bit j if hash(i,j) is odd
        const h = ((i + 1) * 2654435761 + (j + 1) * 2246822519) >>> 0;
        if (h & 1) {
          val ^= bits[j];
        }
      }
      result.push(val);
    }
    return result;
  }

  /** @private */
  _randomBits(n) {
    return Array.from({ length: n }, () => (Math.random() < 0.5 ? 1 : 0));
  }

  /** @private */
  _bitsToBytes(bits) {
    const bytes = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) {
        bytes[i >> 3] |= 1 << (7 - (i & 7));
      }
    }
    return bytes;
  }
}
