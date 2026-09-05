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
// A full round completes in a few seconds even on a slow link; a round still
// unfinished after this long means the peer went silent (crash, one-sided
// abort, dropped message). The deadline aborts every pending mux receive so
// the round fails cleanly instead of wedging the orchestrator forever.
// Overridable for tests via globalThis.QVC_ROUND_DEADLINE_MS.
const ROUND_DEADLINE_MS = 60_000;

function roundDeadlineMs() {
  const v = globalThis.QVC_ROUND_DEADLINE_MS;
  return Number.isFinite(v) && v > 0 ? v : ROUND_DEADLINE_MS;
}

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
    this._roundAbort = null;
    this._deadlineTimer = null;
    this._isInitiator = false;
    this._pendingRoundStart = false;
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
   *
   * @param {boolean} [isInitiator] - whether this side initiates rounds (the
   *   room creator, Alice). The initiator announces rounds and ignores
   *   incoming round-starts; the joiner only ever runs rounds the initiator
   *   announced.
   */
  init(isInitiator = false) {
    if (this._mux) this._mux.close();
    this._roundInProgress = false;
    this._pendingRoundStart = false;
    this._isInitiator = !!isInitiator;
    this._mux = new DataChannelMux((data) => this._webrtc.sendData(data));
    this._listenForRoundStarts();
  }

  /**
   * Follow the peer's round-start announcements.
   *
   * Only Alice initiates rounds (re-keying on budget-low, or immediately on
   * the eavesdropper toggle), and Bob's side has to actually run the protocol
   * for the round to progress — without this listener an Alice-initiated
   * re-key deadlocked, with her qubits sitting unread in Bob's queue.
   * @private
   */
  async _listenForRoundStarts() {
    const mux = this._mux;
    while (this._mux === mux) {
      let msg;
      try {
        msg = await mux.receive('control');
      } catch {
        return; // mux closed by destroy()/re-init — listener is done
      }
      if (!msg || msg.type !== 'round-start') continue;
      // The initiator never follows round-starts: it announces them. Without
      // this guard a hostile peer could inject a round-start and wedge the
      // initiator into a Bob-role round against its own announcements.
      if (this._isInitiator) continue;
      if (this._roundInProgress) {
        // Don't discard: the announcing side has already started its half.
        // Run one deferred round when the current one settles, so a
        // re-key colliding with a retry converges instead of deadlocking.
        this._pendingRoundStart = true;
        continue;
      }
      // The announcing peer runs as Alice; this side joins as Bob.
      this.runRound(false);
    }
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
    if (isAlice) {
      this._isInitiator = true;
      // Anything still buffered belongs to an older (timed-out) round and
      // would desync this one; the peer flushes on the round-start arrival.
      this._mux.flushDataBuffers();
      this._mux.send('control', { type: 'round-start' });
    }
    this._onStateChange({ phase: 'running' });

    this._roundAbort = new AbortController();
    const signal = this._roundAbort.signal;
    this._deadlineTimer = setTimeout(() => {
      this._roundAbort?.abort('timeout');
    }, roundDeadlineMs());

    try {
      const cc = new DataChannelClassicalChannel(this._mux, signal);
      const qc = isAlice
        ? new AliceQuantumChannel(
            this._mux,
            {
              ...CHANNEL_OPTIONS,
              eavesdropperEnabled: this._eavesdropper,
            },
            signal,
          )
        : new BobQuantumChannel(this._mux, signal);

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
          reason: result.abortReason ?? 'qber-exceeded',
        });
        this._scheduleRetry(isAlice);
      }
    } catch (err) {
      this._consecutiveFailures++;
      this._onStateChange({ phase: 'error', error: err });
      this._scheduleRetry(isAlice);
    } finally {
      clearTimeout(this._deadlineTimer);
      this._roundAbort = null;
      this._roundInProgress = false;
      if (this._pendingRoundStart && this._mux) {
        this._pendingRoundStart = false;
        if (!this._isInitiator) this.runRound(false);
      }
    }
  }

  /**
   * Tear down: cancel any pending retry and round deadline, abort the
   * in-flight round, and close the mux so every pending receive (protocol
   * reads and the control listener) rejects instead of hanging forever.
   */
  destroy() {
    clearTimeout(this._retryTimer);
    clearTimeout(this._deadlineTimer);
    this._roundAbort?.abort('destroyed');
    if (this._mux) this._mux.close();
    this._mux = null;
    this._roundInProgress = false;
    this._pendingRoundStart = false;
  }

  /** @private */
  _scheduleRetry(isAlice) {
    if (!this._mux) return; // destroyed mid-round — nothing to retry
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // No more retries — the UI must show this loudly (permanent red pill),
      // not leave a stale "encrypting" state on screen.
      this._onStateChange({ phase: 'exhausted', failures: this._consecutiveFailures });
      return;
    }
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this.runRound(isAlice), RETRY_DELAY_MS);
  }
}
