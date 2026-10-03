/**
 * SimulatedQuantumChannel — models a physical quantum optical channel.
 *
 * Implements photon source (Poisson), fiber attenuation, single-photon
 * detector (APD) with dark counts, polarization misalignment, and an optional
 * eavesdropper.
 *
 * The misalignment term is what makes an undisturbed run's QBER non-zero. A
 * channel with no error rate is not a channel: it skips the error correction
 * and the privacy amplification that the error rate pays for, so the key the
 * simulator produces would come from a path no physical link takes.
 */

export class SimulatedQuantumChannel {
  /**
   * @param {object} options
   * @param {number} options.fiberLengthKm - fiber length in km (default 1.0)
   * @param {number} options.sourceIntensity - mean photon number per pulse (default 0.1)
   * @param {number} options.detectorEfficiency - APD detection efficiency (default 0.10)
   * @param {boolean} options.eavesdropperEnabled - whether Eve intercepts (default false)
   * @param {number} options.misalignmentError - chance a detected photon reads
   *   in the wrong polarization, the link's optical visibility error. 1.5% is
   *   the middle of what short-fiber BB84 benches report (default 0.015)
   * @param {number} options.darkCountRate - chance per slot that the APD fires
   *   with no photon present. 1e-5 is a 1 kHz dark rate in a 10 ns gate, so it
   *   is real but far below the misalignment term here (default 1e-5)
   */
  constructor(options = {}) {
    this._fiberLengthKm = options.fiberLengthKm ?? 1.0;
    this._sourceIntensity = options.sourceIntensity ?? 0.1;
    this._detectorEfficiency = options.detectorEfficiency ?? 0.1;
    this._eavesdropperEnabled = options.eavesdropperEnabled ?? false;
    this._misalignmentError = options.misalignmentError ?? 0.015;
    this._darkCountRate = options.darkCountRate ?? 1e-5;

    // Fiber attenuation: ~0.2 dB/km for standard telecom fiber
    this._attenuationDbPerKm = 0.2;

    this._buffer = [];
    this._resolveWaiter = null;
    this._isReceiver = false;
  }

  /**
   * Create a paired receiver channel.
   * @returns {SimulatedQuantumChannel}
   */
  createReceiver() {
    const receiver = new SimulatedQuantumChannel({
      fiberLengthKm: this._fiberLengthKm,
      sourceIntensity: this._sourceIntensity,
      detectorEfficiency: this._detectorEfficiency,
      eavesdropperEnabled: this._eavesdropperEnabled,
      misalignmentError: this._misalignmentError,
      darkCountRate: this._darkCountRate,
    });
    receiver._isReceiver = true;
    this._peer = receiver;
    return receiver;
  }

  /**
   * Toggle eavesdropper.
   * @param {boolean} enabled
   */
  setEavesdropper(enabled) {
    this._eavesdropperEnabled = enabled;
    if (this._peer) {
      this._peer._eavesdropperEnabled = enabled;
    }
  }

  /**
   * Send qubits through the simulated channel.
   * @param {Array<{bit: number, basis: number}>} qubits
   */
  async sendQubits(qubits) {
    const transmitted = qubits.map((q) => this._simulateTransmission(q));
    const target = this._peer;
    if (!target) throw new Error('No receiver created');
    target._buffer.push(transmitted);
    if (target._resolveWaiter) {
      target._resolveWaiter();
      target._resolveWaiter = null;
    }
  }

  /**
   * Receive qubits from the simulated channel.
   * @returns {Promise<Array<{bit: number, basis: number, detected: boolean}>>}
   */
  async receiveQubits() {
    if (this._buffer.length > 0) {
      return this._buffer.shift();
    }
    return new Promise((resolve) => {
      this._resolveWaiter = () => resolve(this._buffer.shift());
    });
  }

  /** @private Whether a prepared photon survives the link and fires the APD. */
  _photonArrives() {
    const photonProb = 1 - Math.exp(-this._sourceIntensity);
    const attenuationDb = this._attenuationDbPerKm * this._fiberLengthKm;
    const transmittance = Math.pow(10, -attenuationDb / 10);
    return (
      Math.random() <= photonProb &&
      Math.random() <= transmittance &&
      Math.random() <= this._detectorEfficiency
    );
  }

  /**
   * @private Eve's intercept-resend. She measures in a random basis and resends
   * in that one, so a wrong guess randomizes what the receiver then measures.
   */
  _intercept(bit, basis) {
    const eveBasis = Math.random() < 0.5 ? 0 : 1;
    if (eveBasis === basis) return bit;
    return Math.random() < 0.5 ? bit ^ 1 : bit;
  }

  /**
   * Simulate transmission of a single qubit through the channel: Poisson
   * source, fiber attenuation, APD efficiency and dark counts, the optional
   * eavesdropper, and polarization misalignment.
   * @private
   */
  _simulateTransmission(qubit) {
    const { basis } = qubit;

    // A slot no photon reached still fires sometimes. The click is thermal, so
    // its bit carries nothing about what was prepared: half of the dark counts
    // that survive sifting are errors.
    if (!this._photonArrives()) {
      if (Math.random() < this._darkCountRate) {
        return { bit: Math.random() < 0.5 ? 0 : 1, basis, detected: true };
      }
      return { bit: 0, basis, detected: false };
    }

    let bit = this._eavesdropperEnabled ? this._intercept(qubit.bit, basis) : qubit.bit;

    // Misaligned polarization frames, so a share of right-basis photons read
    // wrong. The whole error rate on a short undisturbed fiber.
    if (Math.random() < this._misalignmentError) bit ^= 1;

    return { bit, basis, detected: true };
  }
}
