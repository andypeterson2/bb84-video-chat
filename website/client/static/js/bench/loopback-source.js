/**
 * LoopbackFrameSource — the in-browser simulator as a bench.
 *
 * The source-role peer runs the whole optical path locally per frame:
 * SimulatedQuantumChannel models the photon source, fiber, optional Eve,
 * and detection; the detector's measurement (wrong basis ⇒ coin flip) is
 * applied here too, because in this backend the "detector bench" is also
 * local. The resulting sparse detection set is the *detector peer's* data —
 * the engine ships it across the mux 'quantum' channel, and the detector
 * peer's loopback source surfaces it through onDetections, exactly the way
 * a daemon source surfaces real timetagger output.
 *
 * The peer transport is injected (engine wires it to the mux) so this file
 * stays transport-free and unit-testable.
 */

import { SimulatedQuantumChannel } from '../bb84/simulated.js';

const CHANNEL_OPTIONS = {
  fiberLengthKm: 1.0,
  sourceIntensity: 0.5,
  detectorEfficiency: 0.5,
};

export class LoopbackFrameSource {
  /**
   * @param {object} options
   * @param {'source'|'detector'} options.role
   * @param {function(object): void} [options.sendToPeer] - ships a detection
   *   set to the detector peer (source role only; engine wires to the mux)
   * @param {object} [options.channelOptions] - SimulatedQuantumChannel knobs
   */
  constructor({ role, sendToPeer = null, channelOptions = {} }) {
    this.role = role;
    this._sendToPeer = sendToPeer;
    this._channelOptions = { ...CHANNEL_OPTIONS, ...channelOptions };
    this._eavesdropper = false;
    this._onDetections = null;
    this._onStatus = null;
    this._started = false;
  }

  async connect() {
    // Local backend: nothing to reach.
  }

  async start() {
    this._started = true;
  }

  async stop() {
    this._started = false;
  }

  setEavesdropper(enabled) {
    if (this.role !== 'source') throw new Error('only the source role owns the eavesdropper');
    this._eavesdropper = !!enabled;
  }

  get eavesdropperEnabled() {
    return this._eavesdropper;
  }

  onDetections(cb) {
    this._onDetections = cb;
  }

  onStatus(cb) {
    this._onStatus = cb;
  }

  /**
   * Source role: run the simulated bench for one frame and ship the sparse
   * detection set to the detector peer.
   * @param {{frameId: number, bits: Uint8Array, bases: Uint8Array}} frame
   */
  async transmit(frame) {
    if (this.role !== 'source') throw new Error('transmit is a source-role operation');
    if (!this._started) throw new Error('transmit before start');
    const { frameId, bits, bases } = frame;
    const slots = bits.length;

    const sim = new SimulatedQuantumChannel({
      ...this._channelOptions,
      eavesdropperEnabled: this._eavesdropper,
    });
    const receiver = sim.createReceiver();
    const qubits = new Array(slots);
    for (let i = 0; i < slots; i++) qubits[i] = { bit: bits[i], basis: bases[i] };
    await sim.sendQubits(qubits);
    const transmitted = await receiver.receiveQubits();

    // Detector-bench measurement: random basis per detection; wrong basis
    // yields simulated quantum randomness (physics, not a secret — plain
    // Math.random is deliberate, matching the simulator's own RNG).
    const indices = [];
    const detBits = [];
    const detBases = [];
    for (let i = 0; i < slots; i++) {
      const q = transmitted[i];
      if (q.detected === false) continue;
      const measureBasis = Math.random() < 0.5 ? 0 : 1;
      indices.push(i);
      detBases.push(measureBasis);
      detBits.push(measureBasis === q.basis ? q.bit : Math.random() < 0.5 ? 0 : 1);
    }

    const detections = {
      frameId,
      indices: Uint32Array.from(indices),
      bits: Uint8Array.from(detBits),
      bases: Uint8Array.from(detBases),
      stats: { slots, detections: indices.length },
    };
    this._onStatus?.({ slots, detections: indices.length });
    this._sendToPeer?.(detections);
  }

  /**
   * Detector role: the engine feeds detection sets that arrived from the
   * source peer over the mux into here.
   */
  deliverDetections(detections) {
    if (this.role !== 'detector') throw new Error('deliverDetections is a detector-role operation');
    this._onStatus?.(detections.stats ?? {});
    this._onDetections?.(detections);
  }
}
