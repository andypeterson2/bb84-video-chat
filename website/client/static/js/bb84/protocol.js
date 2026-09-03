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
    // Optional live-progress hook: called with { step, ...detail } as each phase
    // of the round completes, so a UI can animate the pipeline. Off by default.
    this._onPhase = typeof options.onPhase === 'function' ? options.onPhase : null;
    // Optional per-step pause. A full round is sub-second, so on-camera the
    // phases would flash by; a small delay makes them followable. Tests leave
    // this at 0, so they stay fast and deterministic.
    this._stepDelayMs = options.stepDelayMs ?? 0;
  }

  /** Emit a pipeline phase to the optional progress hook. @private */
  _phase(step, detail = {}) {
    if (this._onPhase) this._onPhase({ step, ...detail });
  }

  /** Pause between phases when a step delay is configured (live UI only). @private */
  _pace() {
    if (!this._stepDelayMs) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this._stepDelayMs));
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
    this._phase('transmit', { sent: this._numRawBits });
    await this._pace();

    // Step 2: Basis reconciliation — receive Bob's bases and detection events,
    // send Alice's bases
    const bobAnnouncement = await this._cc.receive();
    const bobBases = bobAnnouncement.bases;

    await this._cc.send(aliceBases);

    // Sift: keep only slots where Bob registered a photon AND the bases agree.
    // The detection filter is load-bearing — an undetected slot still carries a
    // basis and a placeholder bit, so sifting on bases alone mixes ~50%-wrong
    // coin flips into the key. Over a lossy channel that reads as a ~50% QBER
    // and aborts every single round.
    const siftedAlice = this._sift(aliceBases, bobBases, aliceBits, bobAnnouncement.detected);
    metrics.siftedBits = siftedAlice.length;
    metrics.siftingEfficiency = siftedAlice.length / this._numRawBits;
    this._phase('sift', { sifted: siftedAlice.length, raw: this._numRawBits });
    await this._pace();

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
      sampleSize,
    );
    metrics.qber = qber;
    this._phase('qber', { qber, sample: sampleSize });
    await this._pace();

    // Remove sample bits from key material
    const sampleSet = new Set(sampleIndices);
    const keyBitsAlice = siftedAlice.filter((_, i) => !sampleSet.has(i));

    if (qber > this._qberThreshold) {
      metrics.isSecure = false;
      this._phase('abort', { qber });
      await this._cc.send({ type: 'abort', reason: 'qber-exceeded' });
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics };
    }

    await this._cc.send({ type: 'continue' });

    // Step 4: Error correction (simplified binary cascade)
    // Exchange parities for error correction
    const correctedAlice = await this._errorCorrectAlice(keyBitsAlice);
    this._phase('correct', { bits: correctedAlice.length });
    await this._pace();

    // Step 5: Privacy amplification
    // Generate a random Toeplitz seed and share it
    const toeplitzSeed = this._randomBits(correctedAlice.length + this._targetKeyLength - 1);
    await this._cc.send({ type: 'toeplitz-seed', seed: toeplitzSeed });

    const finalBits = this._privacyAmplify(correctedAlice, this._targetKeyLength);
    metrics.keyLength = this._targetKeyLength;
    metrics.isSecure = true;
    metrics.roundDurationMs = Date.now() - startTime;
    this._phase('amplify', { keyLength: this._targetKeyLength });

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
    // Which pulses actually produced a detection event. Channels that model no
    // loss (the ideal channel) omit the flag entirely — every slot counts.
    const bobDetected = received.map((q) => q.detected !== false);
    // Measure: if bases match, bit is correct; otherwise random
    const bobBits = received.map((q, i) => {
      if (bobBases[i] === q.basis) {
        return q.bit;
      }
      return Math.random() < 0.5 ? 0 : 1;
    });
    this._phase('transmit', { sent: this._numRawBits });
    await this._pace();

    // Step 2: Announce Bob's bases and detection events, receive Alice's bases
    await this._cc.send({ bases: bobBases, detected: bobDetected });
    const aliceBases = await this._cc.receive();

    // Sift — same positions Alice keeps (see runAsAlice)
    const siftedBob = this._sift(aliceBases, bobBases, bobBits, bobDetected);
    metrics.siftedBits = siftedBob.length;
    metrics.siftingEfficiency = siftedBob.length / this._numRawBits;
    this._phase('sift', { sifted: siftedBob.length, raw: this._numRawBits });
    await this._pace();

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
    this._phase('qber', { qber, sample: sampleSize });
    await this._pace();

    // Remove sample bits
    const sampleSet = new Set(sampleIndices);
    const keyBitsBob = siftedBob.filter((_, i) => !sampleSet.has(i));

    const decision = await this._cc.receive();
    if (decision.type === 'abort') {
      metrics.isSecure = false;
      this._phase('abort', { qber });
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics };
    }

    // Step 4: Error correction
    const correctedBob = await this._errorCorrectBob(keyBitsBob);
    this._phase('correct', { bits: correctedBob.length });
    await this._pace();

    // Step 5: Privacy amplification
    const toeplitzMsg = await this._cc.receive();
    const finalBits = this._privacyAmplify(correctedBob, this._targetKeyLength);
    metrics.keyLength = this._targetKeyLength;
    metrics.isSecure = true;
    metrics.roundDurationMs = Date.now() - startTime;
    this._phase('amplify', { keyLength: this._targetKeyLength });

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
  _sift(aliceBases, bobBases, bits, detected = null) {
    const result = [];
    for (let i = 0; i < aliceBases.length; i++) {
      // A pulse Bob never registered carries no shared information. Keeping it
      // would inject a coin-flip into both key strings — see runAsAlice.
      if (detected && !detected[i]) continue;
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
