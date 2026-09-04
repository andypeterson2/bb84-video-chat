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

/** Error-correction block size — one parity bit is disclosed per block. */
const PARITY_BLOCK_SIZE = 8;

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
      return { key: null, qber, metrics, abortReason: 'qber-exceeded' };
    }

    // Honest key budget: error correction discloses one parity bit per block
    // on the public channel, and leftover hashing can only distill what Eve
    // does not know — at most (n − leaked) bits. AES-GCM needs exactly
    // targetKeyLength bits, so a short budget aborts the round (a shorter key
    // is not an option) rather than pretending the leak away.
    const leakedBits = Math.ceil(keyBitsAlice.length / PARITY_BLOCK_SIZE);
    metrics.leakedBits = leakedBits;
    if (keyBitsAlice.length - leakedBits < this._targetKeyLength) {
      metrics.isSecure = false;
      this._phase('abort', { qber, reason: 'key-budget' });
      await this._cc.send({ type: 'abort', reason: 'key-budget' });
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics, abortReason: 'key-budget' };
    }

    await this._cc.send({ type: 'continue' });

    // Step 4: Error correction (simplified binary cascade)
    // Exchange parities for error correction
    const correctedAlice = await this._errorCorrectAlice(keyBitsAlice);
    this._phase('correct', { bits: correctedAlice.length });
    await this._pace();

    // Step 5: Privacy amplification
    // Generate a random Toeplitz seed and share it. The seed is public (Eve
    // may see it); the security of leftover hashing comes from it being
    // chosen fresh and uniformly per round, which is why it must come from a
    // crypto-grade RNG.
    const toeplitzSeed = this._randomBits(correctedAlice.length + this._targetKeyLength - 1);
    await this._cc.send({ type: 'toeplitz-seed', seed: toeplitzSeed });

    const finalBits = this._privacyAmplify(correctedAlice, this._targetKeyLength, toeplitzSeed);
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
      // Wrong-basis measurement: simulated quantum randomness (physics, not a
      // secret) — plain Math.random is deliberate here.
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

    // Mirror Alice's key-budget accounting (same n on both sides by
    // construction, so the numbers agree without negotiation).
    metrics.leakedBits = Math.ceil(keyBitsBob.length / PARITY_BLOCK_SIZE);

    const decision = await this._cc.receive();
    if (decision.type === 'abort') {
      metrics.isSecure = false;
      this._phase('abort', { qber, reason: decision.reason });
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics, abortReason: decision.reason ?? 'qber-exceeded' };
    }

    // Step 4: Error correction
    const correctedBob = await this._errorCorrectBob(keyBitsBob);
    this._phase('correct', { bits: correctedBob.length });
    await this._pace();

    // Step 5: Privacy amplification — hash with the SAME Toeplitz matrix
    // Alice used, reconstructed from her transmitted seed. Anything else and
    // the two 128-bit keys are unrelated bit strings.
    const toeplitzMsg = await this._cc.receive();
    const expectedSeedLength = correctedBob.length + this._targetKeyLength - 1;
    if (
      toeplitzMsg?.type !== 'toeplitz-seed' ||
      !Array.isArray(toeplitzMsg.seed) ||
      toeplitzMsg.seed.length !== expectedSeedLength
    ) {
      metrics.isSecure = false;
      this._phase('abort', { qber, reason: 'bad-seed' });
      metrics.roundDurationMs = Date.now() - startTime;
      return { key: null, qber, metrics, abortReason: 'bad-seed' };
    }
    const finalBits = this._privacyAmplify(correctedBob, this._targetKeyLength, toeplitzMsg.seed);
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
    const blockSize = PARITY_BLOCK_SIZE;
    const parities = [];
    for (let i = 0; i < bits.length; i += blockSize) {
      const block = bits.slice(i, i + blockSize);
      parities.push(block.reduce((a, b) => a ^ b, 0));
    }
    await this._cc.send({ type: 'parities', parities });
    // Consume Bob's correction-done — positional queue sync only.
    await this._cc.receive();
    // Alice keeps her bits (she is the reference)
    return [...bits];
  }

  /**
   * Error correction — Bob side (simplified binary cascade).
   * Receives parities from Alice, flips bits in mismatched blocks.
   */
  async _errorCorrectBob(bits) {
    const blockSize = PARITY_BLOCK_SIZE;
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
   * Privacy amplification: multiply the corrected key by a random Toeplitz
   * matrix over GF(2) (the leftover-hash construction).
   *
   * The m×n matrix is defined by the shared seed s of length n + m − 1 via
   * T[i][j] = s[i − j + (n − 1)] — constant along every diagonal, so one seed
   * fixes the whole matrix and both sides reconstruct it identically. Seed
   * values are used mod 2 (& 1), so a malformed-but-right-length seed still
   * yields a well-defined (if useless) matrix rather than NaN bits.
   *
   * @param {Array<number>} bits - corrected key bits (length n)
   * @param {number} targetLength - output length m in bits
   * @param {Array<number>} seed - shared Toeplitz seed, length n + m − 1
   * @returns {Array<number>} - the m hashed bits
   */
  _privacyAmplify(bits, targetLength, seed) {
    const n = bits.length;
    const expected = n + targetLength - 1;
    if (!Array.isArray(seed) || seed.length !== expected) {
      throw new Error(
        `privacy amplification needs a ${expected}-bit Toeplitz seed, got ${
          Array.isArray(seed) ? seed.length : typeof seed
        }`,
      );
    }
    const result = new Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      let val = 0;
      for (let j = 0; j < n; j++) {
        if (bits[j]) val ^= seed[i - j + n - 1] & 1;
      }
      result[i] = val;
    }
    return result;
  }

  /**
   * Crypto-grade random bits. Feeds Alice's raw key bits, both sides' basis
   * choices, and the Toeplitz seed — everything whose predictability would
   * hand Eve the key. (The channel models' Math.random stays: it simulates
   * physics — photon loss, wrong-basis measurement outcomes — not secrets.)
   * @private
   */
  _randomBits(n) {
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b & 1);
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
