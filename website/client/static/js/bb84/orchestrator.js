/**
 * BB84Orchestrator — call lifecycle shell around the ReservoirEngine.
 *
 * Owns everything that lives for the whole call: the mux, channel
 * authentication, the DTLS-fingerprint exchange (with SAS commit-then-reveal)
 * and the derived SAS, backend negotiation, and the exhausted-latch display
 * state. The actual key production — continuous framing, sifting, pooled
 * distillation, rotation — is the ReservoirEngine's, driven by a FrameSource
 * (the in-browser simulator today; a hardware bench daemon later).
 */

import { DataChannelMux, DataChannelClassicalChannel } from './datachannel-adapter.js';
import { AuthenticatedClassicalChannel, ChannelAuth, ChannelAuthError } from './channel-auth.js';
import { ReservoirEngine, encodePeerDetections } from '../bench/reservoir.js';
import { LoopbackFrameSource } from '../bench/loopback-source.js';
import { negotiateBackend } from '../bench/negotiation.js';

/** Slots per loopback frame in the live session (SNSPD-like sim defaults). */
const LIVE_SLOTS_PER_FRAME = 8192;

export class BB84Orchestrator {
  /**
   * @param {object} options
   * @param {import('../webrtc.js').WebRTCManager} options.webrtcManager
   * @param {function(object): void} options.onStateChange - phase events:
   *   'sas' { sas }, 'mode' { mode }, 'reservoir' { qber, accepted, pooledBits,
   *   mintBudget, detections, slots }, 'minted' { keyIndex, poolDepth },
   *   'rotated' { keyIndex, poolDepth }, 'failed' { reason, qber? },
   *   'exhausted' { failures }.
   * @param {number} [options.slotsPerFrame]
   */
  constructor({ webrtcManager, onStateChange, slotsPerFrame = LIVE_SLOTS_PER_FRAME }) {
    this._webrtc = webrtcManager;
    this._onStateChange = onStateChange;
    this._slots = slotsPerFrame;
    this._mux = null;
    this._auth = null;
    this._isInitiator = false;
    this._fpPromise = null;
    this._fps = null;
    this._sas = null;
    this._engine = null;
    this._eavesdropper = false;
    this._bench = null; // { backend, role, connect } — null ⇒ simulated
  }

  /** @returns {boolean} whether the simulated eavesdropper is active. */
  get eavesdropperEnabled() {
    return this._eavesdropper;
  }

  /**
   * Demo intercept-resend toggle. Routed to the frame source (source role
   * only); also clears the latch so recovery to green is observable.
   * @param {boolean} enabled
   */
  setEavesdropper(enabled) {
    this._eavesdropper = !!enabled;
    if (this._engine) this._engine.setEavesdropper(this._eavesdropper);
  }

  /**
   * Declare a hardware bench backend for this call. Wired by app.js from the
   * optical-mode settings; absent ⇒ the simulated (loopback) backend.
   * @param {{backend: 'bench', role: 'source'|'detector', connect: Function}} bench
   */
  configureBench(bench) {
    this._bench = bench;
  }

  /**
   * Initialize the call. Sets up the mux and channel auth, then (async)
   * exchanges fingerprints, negotiates the backend, and starts streaming.
   * Full reset each call, so call #2 is as protected as call #1.
   *
   * @param {object} [options]
   * @param {string} [options.roomToken] - join-link capability token
   * @param {boolean} [options.isInitiator] - this side's call role
   */
  async init({ roomToken, isInitiator } = {}) {
    this.destroy();
    this._destroyed = false;
    this._isInitiator = !!isInitiator;
    this._fpPromise = null;
    this._fps = null;
    this._sas = null;
    this._mux = new DataChannelMux((data) => this._webrtc.sendData(data));
    this._auth = roomToken
      ? await ChannelAuth.create(roomToken, isInitiator ? 'initiator' : 'joiner')
      : null;
    this._startup().catch((err) => {
      // Fingerprint/negotiation bootstrap failed before any streaming: no key
      // is possible, so surface it loudly rather than silently establishing.
      if (!this._destroyed) this._onStateChange({ phase: 'failed', reason: 'setup', error: err });
    });
  }

  /** Route an incoming DataChannel message to the multiplexer. */
  handleMessage(raw) {
    if (this._mux) this._mux.handleMessage(raw);
  }

  /** @private bootstrap: fingerprints → SAS → negotiation → engine. */
  async _startup() {
    await this._ensureFingerprints();
    if (this._destroyed) return;
    if (this._sas) this._onStateChange({ phase: 'sas', sas: this._sas });

    const resolved = await this._negotiate();
    if (this._destroyed) return;
    this._onStateChange({ phase: 'mode', mode: resolved.mode });

    const frameSource = await this._makeFrameSource(resolved);
    if (this._destroyed) return;

    this._engine = new ReservoirEngine({
      mux: this._mux,
      makeClassicalChannel: (domain, signal, muxChannel) =>
        this._makeChannel(domain, signal, muxChannel),
      frameSource,
      installKey: (key, keyIndex) => this._webrtc.setEncryptionKey(key, keyIndex),
      onState: (s) => this._onEngineState(s),
      slotsPerFrame: this._slots,
    });
    if (this._eavesdropper) this._engine.setEavesdropper(true);
    this._engine.start();
  }

  /** @private authenticated (or plain) classical channel bound to a MAC domain.
   * `muxChannel` selects the underlying mux channel (default 'classical'); the
   * engine passes 'control' so session-restart rides an authenticated envelope
   * on its own transport rather than the shared 'classical' one. */
  _makeChannel(domain, signal, muxChannel = 'classical') {
    const raw = new DataChannelClassicalChannel(this._mux, signal, muxChannel);
    return this._auth ? new AuthenticatedClassicalChannel(raw, this._auth, domain) : raw;
  }

  /**
   * Exchange and cross-check DTLS fingerprints once per call, using
   * commit-then-reveal so a MITM relaying SDP cannot pick a colliding
   * certificate after seeing the others (RFC 6189 §4.4.1): the attacker is
   * reduced to one blind guess at the displayed SAS.
   * @private
   */
  async _ensureFingerprints() {
    if (!this._auth || this._fps) return;
    if (!this._fpPromise) {
      const channel = this._makeChannel('fp');
      this._fpPromise = (async () => {
        const fps = this._webrtc.getDtlsFingerprints();
        const nonce = randomHex(16);
        const commit = await commitHash(fps.local, fps.remote, nonce);
        await channel.send({ type: 'fp-commit', commit });
        const peerCommit = await expectFp(channel, 'fp-commit');
        await channel.send({ type: 'fp-reveal', local: fps.local, remote: fps.remote, nonce });
        const peer = await expectFp(channel, 'fp-reveal');
        const expected = await commitHash(peer.local, peer.remote, peer.nonce);
        if (expected !== peerCommit.commit) {
          throw new ChannelAuthError('fingerprint commitment broken');
        }
        if (!fps.local || !fps.remote || peer.local !== fps.remote || peer.remote !== fps.local) {
          throw new ChannelAuthError('DTLS fingerprint views disagree');
        }
        this._fps = fps;
        const fpI = this._auth.role === 'initiator' ? fps.local : fps.remote;
        const fpJ = this._auth.role === 'initiator' ? fps.remote : fps.local;
        this._sas = await this._auth.sas(fpI, fpJ);
      })();
      this._fpPromise.catch(() => {});
    }
    await this._fpPromise;
  }

  /** @private negotiate the backend over its own MAC domain (sim if unauthed). */
  async _negotiate() {
    const backend = this._bench ? 'bench' : 'sim';
    const role = this._bench ? this._bench.role : null;
    if (!this._auth) {
      // Test/harness path: no authenticated channel to negotiate over.
      return {
        mode: backend === 'bench' ? 'optical' : 'sim',
        role: role ?? (this._isInitiator ? 'source' : 'detector'),
      };
    }
    return negotiateBackend(this._makeChannel('nego'), {
      backend,
      role,
      isInitiator: this._isInitiator,
    });
  }

  /** @private build the FrameSource for the resolved backend + physics role. */
  async _makeFrameSource(resolved) {
    if (resolved.mode === 'optical' && this._bench) {
      await this._bench.connect();
      return this._bench.makeFrameSource(resolved.role, this._mux);
    }
    const source = new LoopbackFrameSource({
      role: resolved.role,
      sendToPeer:
        resolved.role === 'source'
          ? (d) => this._mux.send('quantum', encodePeerDetections(d))
          : null,
    });
    return source;
  }

  /** @private translate engine telemetry into UI phase events. */
  _onEngineState(s) {
    switch (s.phase) {
      case 'frame':
        this._onStateChange({
          phase: 'reservoir',
          qber: s.qber,
          accepted: s.accepted,
          pooledBits: s.pooledBits,
          mintBudget: s.mintBudget,
          detections: s.detections,
          slots: s.slots,
        });
        break;
      case 'minted':
        this._onStateChange({ phase: 'minted', keyIndex: s.keyIndex, poolDepth: s.poolDepth });
        break;
      case 'rotated':
        this._onStateChange({ phase: 'rotated', keyIndex: s.keyIndex, poolDepth: s.poolDepth });
        break;
      case 'failed':
        this._onStateChange({ phase: 'failed', reason: s.reason, qber: s.qber });
        break;
      case 'exhausted':
        this._onStateChange({ phase: 'exhausted', failures: s.failures });
        break;
      default:
        break; // 'streaming' is internal
    }
  }

  /** Tear down: stop the engine and close the mux. */
  destroy() {
    this._destroyed = true;
    if (this._engine) {
      this._engine.destroy();
      this._engine = null;
    }
    if (this._mux) {
      this._mux.close();
      this._mux = null;
    }
  }
}

/* ── fingerprint-commitment helpers ─────────────────────────────── */

const te = new TextEncoder();

async function commitHash(local, remote, nonce) {
  const data = te.encode(`fp-commit-v1\n${local}\n${remote}\n${nonce}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function expectFp(channel, type) {
  const msg = await channel.receive();
  if (!msg || msg.type !== type) {
    throw new ChannelAuthError(`expected ${type}, got ${msg?.type ?? typeof msg}`);
  }
  return msg;
}
