/**
 * SimulatedQuantumChannel — models a physical quantum optical channel.
 *
 * Implements photon source (Poisson), fiber attenuation, single-photon
 * detector (APD), and optional eavesdropper.
 */

export class SimulatedQuantumChannel {
  /**
   * @param {object} options
   * @param {number} options.fiberLengthKm - fiber length in km (default 1.0)
   * @param {number} options.sourceIntensity - mean photon number per pulse (default 0.1)
   * @param {number} options.detectorEfficiency - APD detection efficiency (default 0.10)
   * @param {boolean} options.eavesdropperEnabled - whether Eve intercepts (default false)
   */
  constructor(options = {}) {
    this._fiberLengthKm = options.fiberLengthKm ?? 1.0;
    this._sourceIntensity = options.sourceIntensity ?? 0.1;
    this._detectorEfficiency = options.detectorEfficiency ?? 0.1;
    this._eavesdropperEnabled = options.eavesdropperEnabled ?? false;

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

  /**
   * Simulate transmission of a single qubit through the channel.
   * Models: Poisson source, fiber attenuation, eavesdropper, APD detection.
   * @private
   */
  _simulateTransmission(qubit) {
    let { bit, basis } = qubit;

    // Step 1: Poisson photon source — probability of at least one photon
    const photonProb = 1 - Math.exp(-this._sourceIntensity);
    if (Math.random() > photonProb) {
      return { bit: 0, basis, detected: false };
    }

    // Step 2: Fiber attenuation
    const attenuationDb = this._attenuationDbPerKm * this._fiberLengthKm;
    const transmittance = Math.pow(10, -attenuationDb / 10);
    if (Math.random() > transmittance) {
      return { bit: 0, basis, detected: false };
    }

    // Step 3: Eavesdropper (intercept-resend attack)
    if (this._eavesdropperEnabled) {
      // Eve measures in random basis
      const eveBasis = Math.random() < 0.5 ? 0 : 1;
      if (eveBasis !== basis) {
        // Wrong basis measurement — 50% chance of flipping the bit
        if (Math.random() < 0.5) {
          bit = bit ^ 1;
        }
      }
      // Eve resends in her basis (which may differ from Alice's)
      // This effectively randomizes the basis for half the qubits
    }

    // Step 4: Detector efficiency
    if (Math.random() > this._detectorEfficiency) {
      return { bit: 0, basis, detected: false };
    }

    return { bit, basis, detected: true };
  }
}
