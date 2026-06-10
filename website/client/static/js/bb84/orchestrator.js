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

export class BB84Orchestrator {
  /**
   * @param {object} options
   * @param {import('../webrtc.js').WebRTCManager} options.webrtcManager
   * @param {function(object): void} options.onStateChange - called with { phase, ... }
   */
  constructor({ webrtcManager, onStateChange }) {
    this._webrtc = webrtcManager;
    this._onStateChange = onStateChange;
    this._mux = null;
    this._keyIndex = 0;
    this._roundInProgress = false;
    this._consecutiveFailures = 0;
    this._retryTimer = null;
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
        ? new AliceQuantumChannel(this._mux)
        : new BobQuantumChannel(this._mux);

      const protocol = new BB84Protocol(qc, cc);
      const result = isAlice
        ? await protocol.runAsAlice()
        : await protocol.runAsBob();

      if (result.key) {
        this._webrtc.enableEncryption(result.key, this._keyIndex);
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
