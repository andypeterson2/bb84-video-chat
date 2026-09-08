/**
 * Telemetry contract shared by the call window (publisher) and the analytics
 * window (subscriber). Pure and side-effect-free — no BroadcastChannel here — so
 * it runs under vitest and both pages import the exact same shapes.
 *
 * The call window broadcasts a `telemetry` snapshot (throttled + on events); the
 * analytics window may broadcast a `command` back. Everything is same-origin and
 * demo-only. Only REAL call data is ever carried — there are no synthesized
 * values; absent data is null so the UI can show an honest empty state.
 */

/** Same-origin BroadcastChannel name for the analytics bus. */
export const TELEMETRY_CHANNEL = 'qvc-analytics';

/** Discrete timeline event kinds. */
export const EVENT_KINDS = {
  callStart: 'call-start',
  callEnd: 'call-end',
  minted: 'minted',
  rotated: 'rotated',
  sasVerified: 'sas-verified',
  eve: 'eve',
  peerEve: 'peer-eve',
  reconnect: 'reconnect',
  recovered: 'recovered',
  qberAbort: 'qber-abort',
  compromised: 'compromised',
  mode: 'mode',
};

/** Demo commands the analytics window may send back; the call window allowlists these. */
export const COMMANDS = ['toggle-eve', 'force-rotate', 'reset'];

/** True when `msg` is a well-formed, allowlisted command message. */
export function isValidCommand(msg) {
  return (
    !!msg && msg.type === 'command' && typeof msg.cmd === 'string' && COMMANDS.includes(msg.cmd)
  );
}

/**
 * A bounded, in-memory ring buffer of timestamped events for the demo timeline.
 * Oldest entries drop once `cap` is exceeded. Not persisted.
 */
export class EventLog {
  constructor(cap = 100) {
    this._cap = Math.max(1, cap | 0);
    this._events = [];
  }
  /** Append one event; returns it. `t` defaults to now (injectable for tests). */
  log(kind, detail = null, t = Date.now()) {
    const ev = { t, kind, detail };
    this._events.push(ev);
    if (this._events.length > this._cap) this._events.shift();
    return ev;
  }
  /** The most recent `n` events, oldest-first. */
  tail(n = this._cap) {
    return n >= this._events.length ? this._events.slice() : this._events.slice(-n);
  }
  clear() {
    this._events = [];
  }
  get size() {
    return this._events.length;
  }
}

/**
 * Assemble a telemetry snapshot from the call window's live `state`. Pure: reads
 * `state` and `extras` (things not on state — DTLS fingerprints, the event tail,
 * the QBER thresholds, and an injectable clock) and returns a plain object safe
 * to structured-clone across the BroadcastChannel. Every field is a real reading
 * or null; nothing is fabricated.
 * @param {object} state - the call window's state object
 * @param {{fingerprints?: object|null, events?: Array, qberThreshold?: number,
 *          qberWarning?: number, now?: number}} [extras]
 */
export function buildTelemetrySnapshot(state, extras = {}) {
  const { fingerprints = null, events = [], qberThreshold = null, qberWarning = null } = extras;
  const now = extras.now ?? Date.now();
  const q = state.quality || null;
  const c = state.cryptoMetrics || null;
  const mintBudget = state.mintBudget || 0;
  const distillFraction = mintBudget > 0 ? Math.min(1, (state.reservoirBits || 0) / mintBudget) : 0;

  return {
    type: 'telemetry',
    v: 1,
    t: now,
    inCall: !!state.peerConnected,
    bb84Active: !!state.bb84Active,
    elapsed: state.elapsed || 0,
    mode: state.mode || null,
    cipherState: state.cipherState || null,
    keyIndex: state.keyIndex ?? null,

    // Quantum-key pipeline
    qber: state.qber ?? null,
    qberHistory: Array.isArray(state.qberHistory) ? state.qberHistory.slice() : [],
    qberThreshold,
    qberWarning,
    keysMinted: state.keysMinted || 0,
    rotations: state.rotations || 0,
    poolDepth: state.poolDepth || 0,
    reservoirBits: state.reservoirBits || 0,
    mintBudget,
    distillFraction,

    // Security / auth
    sas: state.sas || null,
    sasVerified: !!state.sasVerified,
    fingerprints,

    // Media / network (scalars; the analytics window accumulates its own series)
    quality: q
      ? {
          bandwidthKbps: q.bandwidthKbps ?? null,
          rttMs: q.rttMs ?? null,
          tier: q.tier ?? null,
          limitedBy: q.limitedBy ?? null,
          actualRes: q.actualRes ?? null,
          actualFps: q.actualFps ?? null,
          inRes: q.inRes ?? null,
          inFps: q.inFps ?? null,
        }
      : null,
    crypto: c
      ? {
          encryptLatencyUs: c.encryptLatencyUs ?? null,
          decryptLatencyUs: c.decryptLatencyUs ?? null,
          encryptFrames: c.encryptFrames ?? null,
          decryptFrames: c.decryptFrames ?? null,
          decryptFailures: c.decryptFailures ?? null,
        }
      : null,

    // Demo state
    isInitiator: !!state.isInitiator, // the eavesdropper control is initiator-only
    eavesdropping: !!state.eavesdropper,
    peerEavesdropping: !!state.peerEavesdropping,
    reconnecting: !!state.reconnecting,

    // Timeline
    events: Array.isArray(events) ? events.slice(-100) : [],
  };
}
