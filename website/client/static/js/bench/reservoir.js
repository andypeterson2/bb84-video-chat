/**
 * ReservoirEngine — continuous frame-based key distillation.
 *
 * One engine for every backend: frames stream in from a FrameSource, each
 * frame is sifted and QBER-gated independently, accepted bits pool, and
 * whenever the pool covers a key plus its disclosure leakage a mint runs —
 * concurrently with further streaming — producing keys into a small
 * reservoir that rotates the media encryption on a floored cadence.
 *
 * Precedent: this is the qcrypto decomposition (epoch-partitioned stream,
 * asynchronous error-correction daemon) and the DTU field trial's chunk
 * semantics (bad-QBER chunks discarded, block-accumulated extraction).
 *
 * Failure model mirrors the round engine it replaces: any integrity error,
 * malformed message, or deadline inside a streaming session tears the
 * session down and counts one failure; the source starts a fresh session
 * (new MAC domain `frames-<n>`, sequence spaces reset) announced via an
 * advisory control message; three consecutive failures latch. The latch
 * binds the source side's session starts — the detector keeps following
 * announcements, which is how a latched detector recovers.
 */

import { MuxAbortError } from '../bb84/datachannel-adapter.js';
import {
  randomBits,
  packBits,
  unpackBits,
  toB64,
  fromB64,
  encodeIndices,
  decodeIndices,
} from './packing.js';
import {
  siftSource,
  siftDetector,
  chooseSamplePositions,
  splitSample,
  estimateQber,
} from './sift.js';
import { distillSource, distillDetector, mintable, DistillError } from './distill.js';
import { DEFAULT_SLOTS_PER_FRAME } from './frame-source.js';

const QBER_THRESHOLD = 0.11;
const MAX_CONSECUTIVE_FAILURES = 3;
const TARGET_KEY_BITS = 128;
const POOL_KEY_CAP = 4;

// Tunables with test hooks, following the deadline-global convention.
const FRAME_PERIOD_MS = 250;
const FRAME_DEADLINE_MS = 10_000;
const STREAM_WATCHDOG_MS = 30_000;
const ROTATION_FLOOR_MS = 10_000;
const SESSION_RESTART_DELAY_MS = 1_000;

const tunable = (name, fallback) => {
  const v = globalThis[name];
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
export const framePeriodMs = () => tunable('QVC_FRAME_PERIOD_MS', FRAME_PERIOD_MS);
export const frameDeadlineMs = () => tunable('QVC_FRAME_DEADLINE_MS', FRAME_DEADLINE_MS);
export const streamWatchdogMs = () => tunable('QVC_STREAM_WATCHDOG_MS', STREAM_WATCHDOG_MS);
export const rotationFloorMs = () => tunable('QVC_ROTATION_FLOOR_MS', ROTATION_FLOOR_MS);
export const sessionRestartDelayMs = () =>
  tunable('QVC_SESSION_RESTART_DELAY_MS', SESSION_RESTART_DELAY_MS);

/** A streaming-session failure that should count and restart, not crash. */
class SessionError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'SessionError';
    this.reason = reason;
  }
}

/**
 * Demultiplexes one sequential classical stream into named sub-streams by
 * message-type prefix, with abortable typed receives. The authenticated
 * channel is strictly ordered, so a single reader loop pulls every message
 * and routes it; frame and mint traffic then interleave safely.
 */
class MessageRouter {
  constructor(channel) {
    this._channel = channel;
    this._streams = new Map(); // prefix -> {queue, waiters}
    this._failure = null;
    this._running = true;
    this._pump();
  }

  stream(prefix) {
    if (!this._streams.has(prefix)) {
      this._streams.set(prefix, { queue: [], waiters: [] });
    }
    const s = this._streams.get(prefix);
    return {
      receive: (types, signal) => this._receive(s, types, signal),
    };
  }

  async _pump() {
    while (this._running) {
      let msg;
      try {
        msg = await this._channel.receive();
      } catch (err) {
        if (this._running) this._fail(err);
        return;
      }
      const prefix = typeof msg?.type === 'string' ? msg.type.split('-')[0] : null;
      const s = prefix && this._streams.get(prefix);
      if (!s) continue; // unknown traffic: drop (typed receives catch desync)
      const waiter = s.waiters.shift();
      if (waiter) waiter.resolve(msg);
      else s.queue.push(msg);
    }
  }

  _receive(s, types, signal) {
    if (this._failure) return Promise.reject(this._failure);
    const check = (msg) => {
      if (!msg || typeof msg !== 'object' || !types.includes(msg.type)) {
        throw new SessionError(
          `expected ${types.join('|')}, got ${msg?.type ?? typeof msg}`,
          'protocol',
        );
      }
      return msg;
    };
    if (s.queue.length > 0) {
      return Promise.resolve(s.queue.shift()).then(check);
    }
    if (signal?.aborted) {
      return Promise.reject(new MuxAbortError('receive aborted', signal.reason));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (m) => resolve(m), reject, cleanup: null };
      if (signal) {
        const onAbort = () => {
          const i = s.waiters.indexOf(waiter);
          if (i >= 0) s.waiters.splice(i, 1);
          reject(new MuxAbortError('receive aborted', signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      s.waiters.push(waiter);
    }).then((msg) => {
      return check(msg);
    });
  }

  _fail(err) {
    this._failure = err;
    for (const s of this._streams.values()) {
      for (const w of s.waiters.splice(0)) {
        w.cleanup?.();
        w.reject(err);
      }
    }
  }

  close() {
    this._running = false;
    this._fail(new MuxAbortError('router closed', 'destroyed'));
  }
}

export class ReservoirEngine {
  /**
   * @param {object} options
   * @param {import('../bb84/datachannel-adapter.js').DataChannelMux} options.mux
   * @param {function(string, AbortSignal): {send: Function, receive: Function}} options.makeClassicalChannel -
   *   returns a (typically authenticated) channel bound to a MAC domain,
   *   whose receives abort on the given per-session signal
   * @param {object} options.frameSource - FrameSource implementation
   * @param {function(Uint8Array, number): void} options.installKey
   * @param {function(object): void} options.onState - telemetry/phase events
   * @param {number} [options.slotsPerFrame]
   */
  constructor({ mux, makeClassicalChannel, frameSource, installKey, onState, slotsPerFrame }) {
    this._mux = mux;
    this._makeChannel = makeClassicalChannel;
    this._source = frameSource;
    this._installKey = installKey;
    this._onState = onState;
    this._slots = slotsPerFrame ?? DEFAULT_SLOTS_PER_FRAME;

    this._isSource = frameSource.role === 'source';
    this._destroyed = false;
    this._exhausted = false;
    this._failures = 0;
    this._sessionN = -1;
    this._session = null; // {router, abort, n}
    this._frameId = 0;
    this._mintId = 0;
    this._keyIndex = 0;
    this._pool = [];
    this._acceptedFrames = [];
    this._mintRunning = false;
    this._pendingKeys = [];
    this._lastInstallAt = -Infinity;
    this._installTimer = null;
    this._restartTimer = null;
    this._detectionWaiters = new Map(); // frameId -> {resolve, reject}
    this._detectionBacklog = new Map(); // frameId -> detections

    if (!this._isSource) {
      this._source.onDetections((d) => this._onDetectionsArrived(d));
    }
  }

  /** Begin streaming. The source opens session 0; the detector joins it. */
  start() {
    if (this._destroyed) return;
    this._listenForSessionRestarts();
    if (!this._isSource) this._listenForPeerDetections();
    this._startSession(0);
  }

  /**
   * Loopback path: the source peer ships detection sets over the mux
   * 'quantum' channel; surface them to the local frame source. Defensive
   * decode — this is peer-controlled data. @private
   */
  async _listenForPeerDetections() {
    const mux = this._mux;
    while (!this._destroyed) {
      let payload;
      try {
        payload = await mux.receive('quantum');
      } catch {
        return;
      }
      this.deliverPeerDetections(payload);
    }
  }

  /** Route a detection set that arrived over the mux 'quantum' channel. */
  deliverPeerDetections(payload) {
    if (this._isSource) return;
    const detections = decodePeerDetections(payload);
    if (detections && this._source.deliverDetections) {
      this._source.deliverDetections(detections);
    }
  }

  /** Demo Eve toggle — clears the latch so recovery is observable. */
  setEavesdropper(enabled) {
    if (this._isSource) this._source.setEavesdropper(enabled);
    this._failures = 0;
    if (this._exhausted) {
      this._exhausted = false;
      if (this._isSource && !this._session) {
        // The peer's session is long dead; announce the fresh one so its
        // listener rejoins (same advisory control path as failure restarts).
        const next = this._sessionN + 1;
        this._mux.send('control', { type: 'session-restart', session: next });
        this._startSession(next);
      }
    }
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._installTimer);
    clearTimeout(this._restartTimer);
    this._teardownSession('destroyed');
    this._source.stop?.().catch?.(() => {});
  }

  /* ── Sessions ─────────────────────────────────────────────────── */

  async _listenForSessionRestarts() {
    const mux = this._mux;
    while (!this._destroyed) {
      let msg;
      try {
        msg = await mux.receive('control');
      } catch {
        return;
      }
      if (!msg || msg.type !== 'session-restart') continue;
      // Only the source announces restarts; the source ignores echoes.
      if (this._isSource) continue;
      if (!Number.isInteger(msg.session) || msg.session <= this._sessionN) continue;
      this._teardownSession('peer-restart');
      this._startSession(msg.session);
    }
  }

  _startSession(n) {
    if (this._destroyed || this._session) return;
    if (this._isSource && this._exhausted) return;
    this._sessionN = n;
    const abort = new AbortController();
    // The channel receives the session's abort signal: on teardown its
    // pending mux read rejects, so the router's pump exits instead of
    // lingering as a second reader on the shared classical channel.
    const channel = this._makeChannel(`frames-${n}`, abort.signal);
    const router = new MessageRouter(channel);
    this._session = { n, abort, router, channel };
    this._onState({ phase: 'streaming', session: n });

    const run = this._isSource
      ? this._runSourceSession(router, abort)
      : this._runDetectorSession(router, abort);
    run.catch((err) => this._onSessionFailure(err));
  }

  _teardownSession(reason) {
    const s = this._session;
    if (!s) return;
    this._session = null;
    s.abort.abort(reason);
    s.router.close();
    // Bits accumulated in a dead session cannot align with a fresh one.
    this._pool = [];
    this._acceptedFrames = [];
    this._mintRunning = false;
    for (const [, w] of this._detectionWaiters) w.reject(new MuxAbortError('session down', reason));
    this._detectionWaiters.clear();
    this._detectionBacklog.clear();
  }

  /** Latch: no fresh key is obtainable. Stop rotating so media rides the last
   * installed key and the UI's compromised state is not repainted green by a
   * pooled-key rotation. @private */
  _latch() {
    this._exhausted = true;
    this._pendingKeys = [];
    clearTimeout(this._installTimer);
    this._installTimer = null;
  }

  _onSessionFailure(err) {
    if (this._destroyed || !this._session) return;
    this._teardownSession('failure');
    this._failures++;
    const reason =
      err instanceof DistillError || err?.name === 'ChannelAuthError'
        ? 'integrity'
        : err instanceof MuxAbortError || err?.name === 'MuxAbortError'
          ? 'timeout'
          : err instanceof SessionError
            ? err.reason
            : 'error';
    this._onState({ phase: 'failed', reason, error: err });
    if (this._failures >= MAX_CONSECUTIVE_FAILURES) {
      // The latch stops the SOURCE from opening sessions; the detector keeps
      // following restart announcements — that is how it recovers.
      this._latch();
      this._onState({ phase: 'exhausted', failures: this._failures });
      return;
    }
    if (this._isSource) {
      this._restartTimer = setTimeout(() => {
        if (this._destroyed || this._exhausted) return;
        const next = this._sessionN + 1;
        this._mux.send('control', { type: 'session-restart', session: next });
        this._startSession(next);
      }, sessionRestartDelayMs());
    }
  }

  /* ── Source side ──────────────────────────────────────────────── */

  async _runSourceSession(router, abort) {
    const frames = router.stream('frame');
    await this._source.start({ slotsPerFrame: this._slots });
    while (this._session && this._session.router === router) {
      if (this._pendingKeys.length >= POOL_KEY_CAP) {
        // Reservoir full: idle without opening frames (flow control).
        await delay(framePeriodMs(), abort.signal);
        continue;
      }
      await this._runSourceFrame(frames, abort);
      this._maybeMint(router);
      await delay(framePeriodMs(), abort.signal);
    }
  }

  async _runSourceFrame(frames, abort) {
    const frameId = this._frameId++;
    const deadline = withDeadline(abort.signal, frameDeadlineMs());
    try {
      const bits = randomBits(this._slots);
      const bases = randomBits(this._slots);
      await this._session.channel.send({ type: 'frame-open', frameId, slots: this._slots });
      await this._source.transmit({ frameId, bits, bases });

      const det = await frames.receive(['frame-detections'], deadline.signal);
      requireFrame(det, frameId);
      const indices = decodeIndices(fromB64OrThrow(det.indices));
      const detBases = unpackBits(fromB64OrThrow(det.bases), indices.length);
      const { keyBits, basesAtIndices } = siftSource(bits, bases, indices, detBases);
      await this._session.channel.send({
        type: 'frame-bases',
        frameId,
        bases: toB64(packBits(basesAtIndices)),
        count: basesAtIndices.length,
      });

      const positions = chooseSamplePositions(keyBits.length);
      const { sample, remaining } = splitSample(keyBits, positions);
      await this._session.channel.send({
        type: 'frame-sample',
        frameId,
        positions: toB64(encodeIndices(positions)),
        values: toB64(packBits(sample)),
        count: sample.length,
      });
      const resp = await frames.receive(['frame-sample-resp'], deadline.signal);
      requireFrame(resp, frameId);
      const theirValues = unpackBits(fromB64OrThrow(resp.values), sample.length);
      const qber = estimateQber(sample, Array.from(theirValues));

      await this._exchangeVerdict(frames, deadline.signal, {
        frameId,
        qber,
        remaining,
        stats: { sifted: keyBits.length, slots: this._slots },
      });
    } finally {
      deadline.clear();
    }
  }

  /* ── Detector side ────────────────────────────────────────────── */

  async _runDetectorSession(router, abort) {
    const frames = router.stream('frame');
    await this._source.start({ slotsPerFrame: this._slots });
    while (this._session && this._session.router === router) {
      const watchdog = withDeadline(abort.signal, streamWatchdogMs());
      let open;
      try {
        open = await frames.receive(['frame-open'], watchdog.signal);
      } finally {
        watchdog.clear();
      }
      await this._runDetectorFrame(frames, abort, open);
      this._maybeMint(router);
    }
  }

  async _runDetectorFrame(frames, abort, open) {
    const frameId = open.frameId;
    const deadline = withDeadline(abort.signal, frameDeadlineMs());
    try {
      const det = await this._awaitDetections(frameId, deadline.signal);
      await this._session.channel.send({
        type: 'frame-detections',
        frameId,
        indices: toB64(encodeIndices(Array.from(det.indices))),
        bases: toB64(packBits(det.bases)),
        count: det.indices.length,
      });
      const basesMsg = await frames.receive(['frame-bases'], deadline.signal);
      requireFrame(basesMsg, frameId);
      const srcBases = unpackBits(fromB64OrThrow(basesMsg.bases), det.indices.length);
      const keyBits = siftDetector(det.bits, det.bases, srcBases);

      const sampleMsg = await frames.receive(['frame-sample'], deadline.signal);
      requireFrame(sampleMsg, frameId);
      const positions = Array.from(decodeIndices(fromB64OrThrow(sampleMsg.positions)));
      if (positions.some((p) => p >= keyBits.length) || positions.length > keyBits.length) {
        throw new SessionError('sample positions out of bounds', 'protocol');
      }
      const { sample, remaining } = splitSample(keyBits, positions);
      await this._session.channel.send({
        type: 'frame-sample-resp',
        frameId,
        values: toB64(packBits(sample)),
      });
      const theirValues = unpackBits(fromB64OrThrow(sampleMsg.values), sample.length);
      const qber = estimateQber(sample, Array.from(theirValues));

      await this._exchangeVerdict(frames, deadline.signal, {
        frameId,
        qber,
        remaining,
        stats: { sifted: keyBits.length, slots: open.slots },
      });
    } finally {
      deadline.clear();
    }
  }

  _onDetectionsArrived(detections) {
    const w = this._detectionWaiters.get(detections.frameId);
    if (w) {
      this._detectionWaiters.delete(detections.frameId);
      w.resolve(detections);
    } else {
      this._detectionBacklog.set(detections.frameId, detections);
      // Bounded: a hostile peer must not grow this map without limit.
      if (this._detectionBacklog.size > 8) {
        const oldest = this._detectionBacklog.keys().next().value;
        this._detectionBacklog.delete(oldest);
      }
    }
  }

  _awaitDetections(frameId, signal) {
    const backlogged = this._detectionBacklog.get(frameId);
    if (backlogged) {
      this._detectionBacklog.delete(frameId);
      return Promise.resolve(backlogged);
    }
    if (signal?.aborted) {
      return Promise.reject(new MuxAbortError('detections wait aborted', signal.reason));
    }
    return new Promise((resolve, reject) => {
      this._detectionWaiters.set(frameId, { resolve, reject });
      signal?.addEventListener(
        'abort',
        () => {
          if (this._detectionWaiters.get(frameId)) {
            this._detectionWaiters.delete(frameId);
            reject(new MuxAbortError('detections wait aborted', signal.reason));
          }
        },
        { once: true },
      );
    });
  }

  /* ── Shared frame tail: verdicts, pooling, telemetry ──────────── */

  async _exchangeVerdict(frames, signal, frame) {
    const { frameId, qber, remaining, stats } = frame;
    const accept = qber <= QBER_THRESHOLD;
    await this._session.channel.send({ type: 'frame-verdict', frameId, qber, accept });
    const theirs = await frames.receive(['frame-verdict'], signal);
    requireFrame(theirs, frameId);
    const accepted = accept && theirs.accept === true;
    if (accepted) {
      this._pool.push(...remaining);
      this._acceptedFrames.push(frameId);
      this._failures = 0;
      this._exhausted = false;
    } else {
      this._failures++;
      this._onState({ phase: 'failed', reason: 'qber-exceeded', qber, frameId });
      if (this._failures >= MAX_CONSECUTIVE_FAILURES) {
        this._latch();
        this._onState({ phase: 'exhausted', failures: this._failures });
        // Both roles tear the session down: the source goes idle until the
        // Eve toggle clears the latch; the detector frees `_session` so it
        // can accept the source's eventual restart announcement.
        this._teardownSession('exhausted');
        return;
      }
    }
    this._onState({
      phase: 'frame',
      frameId,
      qber,
      accepted,
      pooledBits: this._pool.length,
      mintBudget: mintBudgetBits(this._pool.length),
      ...stats,
    });
  }

  /* ── Minting & rotation ───────────────────────────────────────── */

  _maybeMint(router) {
    if (this._mintRunning || !this._session || this._session.router !== router) return;
    if (!mintable(this._pool.length, TARGET_KEY_BITS)) return;
    if (this._pendingKeys.length >= POOL_KEY_CAP) return;
    this._mintRunning = true;
    this._runMint(router)
      .catch((err) => this._onSessionFailure(err))
      .finally(() => {
        this._mintRunning = false;
      });
  }

  async _runMint(router) {
    const mints = router.stream('mint');
    const mintId = this._mintId++;
    const pool = this._pool.splice(0);
    const frameIds = this._acceptedFrames.splice(0);
    const io = {
      send: (msg) => this._session.channel.send(msg),
      receive: (types) => mints.receive(types, this._session.abort.signal),
    };
    let key;
    if (this._isSource) {
      await io.send({ type: 'mint-begin', mintId, frameIds, poolLen: pool.length });
      key = await distillSource(pool, io, { mintId, target: TARGET_KEY_BITS });
    } else {
      const begin = await mints.receive(['mint-begin'], this._session.abort.signal);
      if (
        begin.mintId !== mintId ||
        begin.poolLen !== pool.length ||
        !sameFrameIds(begin.frameIds, frameIds)
      ) {
        throw new DistillError('mint pool divergence (accepted frame sets differ)', 'divergence');
      }
      key = await distillDetector(pool, io, { mintId, target: TARGET_KEY_BITS });
    }
    const keyIndex = this._keyIndex++;
    this._pendingKeys.push({ key, keyIndex });
    this._onState({ phase: 'minted', keyIndex, poolDepth: this._pendingKeys.length, mintId });
    this._scheduleInstall();
  }

  _scheduleInstall() {
    if (this._installTimer || this._pendingKeys.length === 0) return;
    while (this._pendingKeys.length > POOL_KEY_CAP) this._pendingKeys.shift();
    const wait = Math.max(0, this._lastInstallAt + rotationFloorMs() - Date.now());
    this._installTimer = setTimeout(() => {
      this._installTimer = null;
      const next = this._pendingKeys.shift();
      if (!next || this._destroyed) return;
      this._lastInstallAt = Date.now();
      this._installKey(next.key, next.keyIndex);
      this._onState({
        phase: 'rotated',
        keyIndex: next.keyIndex,
        poolDepth: this._pendingKeys.length,
      });
      this._scheduleInstall();
    }, wait);
  }
}

/* ── Small helpers ──────────────────────────────────────────────── */

/** Encode a detection set for the mux 'quantum' channel (loopback path). */
export function encodePeerDetections(d) {
  return {
    frameId: d.frameId,
    indices: toB64(encodeIndices(Array.from(d.indices))),
    bits: toB64(packBits(d.bits)),
    bases: toB64(packBits(d.bases)),
    count: d.indices.length,
    stats: d.stats ?? null,
  };
}

/** Decode a peer detection set; null on malformed input (hostile peer). */
export function decodePeerDetections(p) {
  if (!p || typeof p !== 'object' || !Number.isInteger(p.frameId)) return null;
  if (!Number.isInteger(p.count) || p.count < 0 || p.count > 1 << 20) return null;
  const idx = fromB64(p.indices);
  const bits = fromB64(p.bits);
  const bases = fromB64(p.bases);
  if (!idx || !bits || !bases) return null;
  try {
    const indices = decodeIndices(idx);
    if (indices.length !== p.count) return null;
    return {
      frameId: p.frameId,
      indices,
      bits: unpackBits(bits, p.count),
      bases: unpackBits(bases, p.count),
      stats: p.stats ?? {},
    };
  } catch {
    return null;
  }
}

function mintBudgetBits(poolLen) {
  // Display value: bits still needed before a mint can run.
  let need = TARGET_KEY_BITS;
  for (let n = poolLen; ; n++) {
    if (mintable(n, TARGET_KEY_BITS)) {
      need = n;
      break;
    }
    if (n > poolLen + 4096) break;
  }
  return need;
}

function requireFrame(msg, frameId) {
  if (msg.frameId !== frameId) {
    throw new SessionError(
      `frame id mismatch: expected ${frameId}, got ${msg.frameId}`,
      'protocol',
    );
  }
}

function fromB64OrThrow(b64) {
  const bytes = fromB64(b64);
  if (!bytes) throw new SessionError('malformed base64 payload', 'protocol');
  return bytes;
}

function sameFrameIds(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function withDeadline(parentSignal, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  const onParent = () => ctl.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', onParent, { once: true });
  if (parentSignal?.aborted) ctl.abort(parentSignal.reason);
  return {
    signal: ctl.signal,
    clear: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParent);
    },
  };
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
