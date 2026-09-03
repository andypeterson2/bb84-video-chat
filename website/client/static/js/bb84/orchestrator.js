/**
 * BB84Orchestrator — manages the lifecycle of BB84 key exchange rounds
 * and wires derived keys into the Insertable Streams encryption pipeline.
 */

import { BB84Protocol } from './protocol.js';
import {
  DataChannelMux,
  AliceQuantumChannel,
  BobQuantumChannel,
  DataChannelClassicalChannel,
} from './datachannel-adapter.js';

const MAX_CONSECUTIVE_FAILURES = 3;
const RETRY_DELAY_MS = 5000;

/**
 * Simulated-channel parameters for the live session.
 *
 * The simulator's own defaults (μ=0.1 photons/pulse, 10% detector efficiency)
 * model a conservative APD link with a ~1% detection rate — from 4096 pulses
 * that leaves a couple of dozen sifted bits, far too few to distill a 128-bit
 * key or to estimate QBER with any confidence. These values correspond to a
 * short fiber run with superconducting detectors, and yield ~1000 sifted bits
 * per round with QBER estimated over a ~250-bit sample, so an intercept-resend
 * attack is unambiguous rather than statistical noise.
 */
const CHANNEL_OPTIONS = {
  fiberLengthKm: 1.0,
  sourceIntensity: 0.5,
  detectorEfficiency: 0.5,
};

/** Raw pulses per round — sized so one round yields a full 128-bit key. */
const PROTOCOL_OPTIONS = { numRawBits: 8192 };

export class BB84Orchestrator {
  /**
   * @param {object} options
   * @param {import('../webrtc.js').WebRTCManager} options.webrtcManager
   * @param {function(object): void} options.onStateChange - called with { phase, ... }.
   *   phase is 'running' | 'progress' | 'complete' | 'failed' | 'error'. A 'progress'
   *   event also carries { step, ...detail } for the live pipeline (transmit → sift →
   *   qber → correct → amplify, or 'abort' when the QBER trips the threshold).
   * @param {number} [options.stepDelayMs] - pause between pipeline steps so the phases
   *   are followable on screen. Defaults to 0 (instant) — tests rely on that.
   */
  constructor({ webrtcManager, onStateChange, stepDelayMs = 0 }) {
    this._webrtc = webrtcManager;
    this._onStateChange = onStateChange;
    this._stepDelayMs = stepDelayMs;
    this._mux = null;
    this._keyIndex = 0;
    this._roundInProgress = false;
    this._consecutiveFailures = 0;
    this._retryTimer = null;
    this._eavesdropper = false;
  }

  /**
   * Enable or disable the simulated intercept-resend eavesdropper.
   *
   * Only Alice's side has an effect — she owns the simulated quantum channel;
   * Bob simply observes the elevated QBER and rejects the key. Takes effect on
   * the next round. Toggling also clears the failure/retry state: without that,
   * three eavesdropped rounds would latch retries off permanently and turning
   * Eve back off would never recover.
   *
   * @param {boolean} enabled
   */
  setEavesdropper(enabled) {
    this._eavesdropper = !!enabled;
    this._consecutiveFailures = 0;
    clearTimeout(this._retryTimer);
  }

  /** @returns {boolean} whether the simulated eavesdropper is active. */
  get eavesdropperEnabled() {
    return this._eavesdropper;
  }

  /**
   * Initialize the multiplexer. Call once on data-channel-open.
   */
  init() {
    this._mux = new DataChannelMux((data) => this._webrtc.sendData(data));
  }

  /**
   * Route an incoming DataChannel message to the multiplexer.
   * @param {string} raw
   */
  handleMessage(raw) {
    if (this._mux) this._mux.handleMessage(raw);
  }

  /**
   * Run a single BB84 key exchange round.
   * @param {boolean} isAlice - true if this peer is the initiator (Alice)
   */
  async runRound(isAlice) {
    if (this._roundInProgress || !this._mux) return;
    this._roundInProgress = true;
    this._onStateChange({ phase: 'running' });

    try {
      const cc = new DataChannelClassicalChannel(this._mux);
      const qc = isAlice
        ? new AliceQuantumChannel(this._mux, {
            ...CHANNEL_OPTIONS,
            eavesdropperEnabled: this._eavesdropper,
          })
        : new BobQuantumChannel(this._mux);

      const protocol = new BB84Protocol(qc, cc, {
        ...PROTOCOL_OPTIONS,
        stepDelayMs: this._stepDelayMs,
        onPhase: (p) => this._onStateChange({ phase: 'progress', ...p }),
      });
      const result = isAlice ? await protocol.runAsAlice() : await protocol.runAsBob();

      if (result.key) {
        // WebRTCManager's key-handoff API is setEncryptionKey(rawKey, keyIndex) —
        // it posts the key to the Insertable Streams crypto worker.
        this._webrtc.setEncryptionKey(result.key, this._keyIndex);
        this._onStateChange({
          phase: 'complete',
          qber: result.qber,
          keyIndex: this._keyIndex,
          metrics: result.metrics,
        });
        this._keyIndex++;
        this._consecutiveFailures = 0;
      } else {
        this._consecutiveFailures++;
        this._onStateChange({
          phase: 'failed',
          qber: result.qber,
          reason: 'qber-exceeded',
        });
        this._scheduleRetry(isAlice);
      }
    } catch (err) {
      this._consecutiveFailures++;
      this._onStateChange({ phase: 'error', error: err });
      this._scheduleRetry(isAlice);
    } finally {
      this._roundInProgress = false;
    }
  }

  /** Cancel any pending retry. */
  destroy() {
    clearTimeout(this._retryTimer);
  }

  /** @private */
  _scheduleRetry(isAlice) {
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this.runRound(isAlice), RETRY_DELAY_MS);
  }
}
