/**
 * QKD Video Chat — browser-native WebRTC frontend.
 *
 * Architecture:
 *   Browser ↔ Signaling Server (Socket.IO): SDP + ICE relay
 *   Browser ↔ Browser (WebRTC): peer-to-peer media + DataChannel
 *   Insertable Streams: AES-GCM frame encryption with BB84-derived keys
 *   DataChannel: BB84 key exchange messages
 */

/* ── State ──────────────────────────────────────────────────────── */
const state = {
  signalingConnected: false,
  peerConnected: false,
  roomId: '',
  isInitiator: false,
  waitingForPeer: false,
  cameraOn: true,
  muted: false,
  elapsed: 0,
  bb84Active: false,
  qber: null,
  qberHistory: [], // per-frame QBER, most recent last (capped for the strip chart)
  keyIndex: null,
  // Reservoir telemetry: the key currently being distilled and the pool.
  /** 'sim' | 'optical' (backend badge; never claim photons that weren't) */
  mode: null,
  /** Accepted sifted bits pooled toward the next key. */
  reservoirBits: 0,
  /** Bits needed before a mint can run. */
  mintBudget: null,
  keysMinted: 0,
  rotations: 0,
  poolDepth: 0, // keys waiting in the reservoir to rotate in
  lastDetections: null,
  /**
   * 'establishing' | 'encrypted' | 'unencrypted' | 'compromised' (re-key
   * exhausted; last good key still active). Set only by the crypto worker's
   * cipher-state messages (or BB84 giving up), never by UI bookkeeping.
   */
  cipherState: 'establishing',
  joinLink: '',
  sas: null, // {digits, emoji[]} — the fingerprint-bound short authentication string
  eavesdropper: false,
  /**
   * Optical bench (hardware daemon) settings, persisted per-origin. Optical mode
   * engages only if the peer presents a complementary bench; otherwise both
   * sides fall back to the simulator.
   */
  optical: { enabled: false, url: 'ws://127.0.0.1:8781', token: '' },
  /** Pairing feedback shown in the optical settings row. */
  opticalStatus: '',
  /** Adaptive-quality telemetry {tier, bandwidthKbps, rttMs, limitedBy, ...}. */
  quality: null,
  /** Per-frame encrypt/decrypt latency from the crypto worker (1/s). */
  cryptoMetrics: null,
  /** Camera/mic permission failure, shown inline in the lobby. */
  mediaError: '',
  /** User compared the SAS on camera and confirmed it matches. */
  sasVerified: false,
  /** Join clicked, waiting for the peer connection to establish. */
  joining: false,
  /** Arrived via an invite link (a room token is in the URL). */
  invited: false,
  /** ICE dropped mid-call; the transport is being restored. */
  reconnecting: false,
  /** The other peer is running the eavesdropper demo. */
  peerEavesdropping: false,
  /** The BB84 telemetry panel is expanded (video-first default). */
  dashboardExpanded: false,
};

const OPTICAL_STORAGE_KEY = 'qvc.optical';
// The pairing token is a live credential, so it lives in sessionStorage and dies
// with the tab; only non-secret settings persist in localStorage.
const OPTICAL_TOKEN_KEY = 'qvc.optical.token';

/** Per-frame QBER points kept for the strip chart. */
const QBER_HISTORY_CAP = 120;

/** BB84 aborts above this QBER — intercept-resend lands near 25%. */
const QBER_THRESHOLD = 0.11;
/** Below the abort threshold but above ordinary channel noise. */
const QBER_WARNING = 0.08;

// Room token arriving via an invite link's #room= fragment (prefills Join).
let pendingRoomToken = '';

let elapsedInterval = null;
let socket = null;
let webrtcManager = null;
let localStream = null;
let remoteStream = null;
let bb84 = null;
let benchConnection = null; // live DaemonConnection while optical mode is armed
let qualityController = null; // adaptive bitrate/resolution while a call is up
let QualityControllerCls = null; // resolved from the dynamic import

// Analytics telemetry bus for the second-window demo screen. Null until init's
// dynamic import resolves, and on browsers without BroadcastChannel.

/** BroadcastChannel('qvc-analytics') */
let telemetryBus = null;
/** 250ms coalesced publisher while a call is up. */
let telemetryTimer = null;
/** EventLog instance (timeline ring buffer). */
let eventLog = null;
/** buildTelemetrySnapshot */
let buildSnapshot = null;
/** EVENT_KINDS; empty until the telemetry module loads. */
let EVENT = {};

/* ── Icons ──────────────────────────────────────────────────────── */
const ICONS = {
  cameraOn:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="14" height="14"/><path d="M16 10l6-3v10l-6-3"/></svg>',
  cameraOff:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="14" height="14"/><path d="M16 10l6-3v10l-6-3"/><line x1="2" y1="3" x2="22" y2="21" stroke-width="2"/></svg>',
  micOn:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="2" width="8" height="12"/><path d="M4 10v1a8 8 0 0016 0v-1"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
  micOff:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="2" width="8" height="12"/><path d="M4 10v1a8 8 0 0016 0v-1"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="2" y1="3" x2="22" y2="21" stroke-width="2"/></svg>',
  phoneOff:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 004.05.7 2 2 0 011.98 2v3.5a2 2 0 01-2.18 2A19.79 19.79 0 013.07 4.18 2 2 0 015.07 2H8.6a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L9.58 9.91"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="2"/></svg>',
  analytics:
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3v18h18"/><path d="M7 14l3-4 3 2 4-6"/></svg>',
};

/* ── Signaling ──────────────────────────────────────────────────── */

/**
 * Fetch ICE servers (STUN + short-lived TURN credentials) from the signaling
 * backend. Falls back to public STUN so a fetch failure never blocks calling —
 * relay-requiring peers just won't connect, exactly as before this endpoint.
 * @param {string} base - signaling origin
 * @returns {Promise<RTCIceServer[]>}
 */
async function fetchIceServers(base) {
  const fallback = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/ice-servers`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    const data = await res.json();
    return Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : fallback;
  } catch {
    return fallback;
  }
}

function connectToSignaling(url) {
  if (socket) socket.disconnect();
  socket = io(url, { transports: ['websocket'] });

  socket.on('connect', () => {
    state.signalingConnected = true;
    render();
  });
  socket.on('disconnect', () => {
    state.signalingConnected = false;
    state.peerConnected = false;
    render();
  });
  socket.on('welcome', () => render());

  Promise.all([
    import('./js/webrtc.js'),
    import('./js/bb84/orchestrator.js'),
    import('./js/quality.js'),
    import('./js/analytics/telemetry.js'),
  ]).then(
    async ([
      { WebRTCManager },
      { BB84Orchestrator },
      { QualityController },
      { buildTelemetrySnapshot, EventLog, EVENT_KINDS, isValidCommand, TELEMETRY_CHANNEL },
    ]) => {
      QualityControllerCls = QualityController;
      // Wire the analytics telemetry bus (a second-window demo screen listens).
      buildSnapshot = buildTelemetrySnapshot;
      eventLog = new EventLog(100);
      EVENT = EVENT_KINDS;
      setupTelemetryBus(TELEMETRY_CHANNEL, isValidCommand);
      // STUN + short-lived TURN from the signaling backend, so no long-lived relay
      // secret ships to the client; the first PeerConnection needs them.
      const iceServers = await fetchIceServers(url);
      // The crypto worker is FAIL-CLOSED: it drops every frame until BB84
      // delivers a key, then encrypts with no renegotiation.
      webrtcManager = new WebRTCManager(socket, { enableEncryption: true, iceServers });

      bb84 = new BB84Orchestrator({
        webrtcManager,
        onStateChange: handleBB84State,
      });

      webrtcManager.on('room-created', (d) => {
        state.roomId = d.room_id;
        // The invite link IS the credential (an unguessable room token); the
        // fragment keeps it out of server logs and Referer headers.
        state.joinLink = `${window.location.origin}${window.location.pathname}#room=${encodeURIComponent(d.room_id)}`;
        state.waitingForPeer = true;
        render();
      });
      webrtcManager.on('room-joined', async (d) => {
        state.roomId = d.room_id || state.roomId;
        state.waitingForPeer = false;
        if (!localStream) {
          localStream = await webrtcManager.getLocalMedia();
          showLocalVideo(localStream);
        }
      });
      webrtcManager.on('remote-stream', (d) => {
        state.peerConnected = true;
        state.joining = false;
        state.reconnecting = false;
        state.elapsed = 0;
        startTimer();
        showRemoteVideo(d.stream);
        startQualityController();
        startTelemetryPublisher();
        logEvent(EVENT.callStart);
        render();
      });
      webrtcManager.on('data-channel-open', () => {
        state.bb84Active = true;
        render();
        // init() must run promptly so both sides' muxes exist before either
        // sends (any optical bench was paired earlier, off this path). A
        // rejection means the secure-channel bootstrap failed, so surface it.
        bb84.init({ roomToken: state.roomId, isInitiator: state.isInitiator }).catch(() => {
          state.cipherState = 'compromised';
          showToast('Secure-channel setup failed — no key will be established.', 'error');
          render();
        });
      });
      webrtcManager.on('data-channel-message', (d) => bb84.handleMessage(d));
      webrtcManager.on('peer-disconnected', () => {
        resetSession();
        render();
        showToast('Your partner left the call.', 'info');
      });
      webrtcManager.on('error', (d) => showToast(d.message || 'Something went wrong.', 'error'));
      webrtcManager.on('state-change', (d) => {
        // Stay in-call, showing a reconnecting indicator, across a transient ICE
        // blip; only an explicit leave / peer-disconnect tears down.
        if (d.state === 'connected' || d.state === 'completed') {
          if (state.reconnecting) logEvent(EVENT.recovered);
          state.peerConnected = true;
          state.reconnecting = false;
        } else if ((d.state === 'disconnected' || d.state === 'failed') && state.peerConnected) {
          if (!state.reconnecting) logEvent(EVENT.reconnect);
          state.reconnecting = true;
        }
        render();
      });
      // The other peer toggled the eavesdropper demo — surface it so the joiner
      // (who has no toggle) doesn't read the QBER spike as a real attack.
      socket.on('eve-demo', (d) => {
        state.peerEavesdropping = !!(d && d.active);
        logEvent(EVENT.peerEve, { active: state.peerEavesdropping });
        render();
      });
      webrtcManager.on('cipher-state', (msg) => {
        if (msg.state === 'encrypting') {
          state.cipherState = 'encrypted';
          state.keyIndex = msg.keyIndex;
        } else if (msg.state === 'worker-error') {
          state.cipherState = 'unencrypted';
          showToast('Encryption worker failed — media is blocked, not sent in the clear.');
        } else if (msg.state === 'unsupported') {
          // No RTCRtpScriptTransform: frames CANNOT be encrypted, and the UI
          // must never claim otherwise.
          state.cipherState = 'unsupported';
          showToast('This browser cannot encrypt media frames — no key will be used.');
        } else if (msg.state === 'keyless') {
          // Dropping frames: normal before the first key; after one, the keyed
          // worker was replaced, a downgrade shown loudly.
          state.cipherState = hasBeenEncrypted() ? 'unencrypted' : 'establishing';
        }
        render();
      });
      // Aggregated by the worker (at most one message per second). A burst of
      // failures during a re-key is normal; a sustained stream is not.
      webrtcManager.on('decrypt-error', (msg) => {
        console.warn(`Frame decrypt failures in the last interval: ${msg.failures ?? 1}`);
      });
      // Per-frame encrypt/decrypt latency, aggregated 1/s by the worker. Stored
      // for the diagnostics line; no render() here — it's picked up on the next
      // quality-driven render (every 2s), which is plenty for a readout.
      webrtcManager.on('crypto-metrics', (msg) => {
        state.cryptoMetrics = msg;
      });
    },
  );
}

/* ── BB84 ───────────────────────────────────────────────────────── */

/**
 * Reservoir engine telemetry → UI. Keys are minted continuously and rotated
 * into the crypto worker on a floored cadence; the cipher pill is driven by
 * the worker's own cipher-state events (not from here), so this handler only
 * maintains the dashboard and the loud failure states.
 */
function handleBB84State(s) {
  switch (s.phase) {
    case 'sas':
      state.sas = s.sas;
      break;
    case 'mode':
      state.mode = s.mode;
      logEvent(EVENT.mode, { mode: s.mode });
      if (s.mode !== 'optical' && benchConnection) {
        // Negotiation fell back to the simulator (the peer had no
        // complementary bench). Drop the daemon connection we won't use.
        benchConnection.close();
        benchConnection = null;
        if (state.optical.enabled) {
          showToast('Peer has no optical bench — using the simulator on both sides.');
        }
      }
      break;
    case 'reservoir':
      if (typeof s.qber === 'number') {
        state.qber = s.qber;
        state.qberHistory.push(s.qber);
        if (state.qberHistory.length > QBER_HISTORY_CAP) state.qberHistory.shift();
      }
      state.reservoirBits = s.pooledBits ?? state.reservoirBits;
      state.mintBudget = s.mintBudget ?? state.mintBudget;
      state.lastDetections = s.detections ?? state.lastDetections;
      break;
    case 'minted':
      state.keysMinted++;
      state.keyIndex = s.keyIndex;
      state.poolDepth = s.poolDepth ?? state.poolDepth;
      logEvent(EVENT.minted, { keyIndex: s.keyIndex });
      break;
    case 'rotated':
      state.rotations++;
      state.poolDepth = s.poolDepth ?? state.poolDepth;
      logEvent(EVENT.rotated, { keyIndex: s.keyIndex });
      break;
    case 'failed':
      handleReservoirFailure(s);
      break;
    case 'exhausted':
      // Frames still ride the LAST good key (the worker never downgrades), but no
      // fresh key is obtainable: show red and leave the decision to the user.
      state.cipherState = 'compromised';
      logEvent(EVENT.compromised);
      showToast('Channel integrity lost — tampering or a persistent fault. Leave and retry.');
      break;
    default:
      break;
  }
  render();
}

/** A single failed frame/session is transient; only 'exhausted' is terminal. */
function handleReservoirFailure(s) {
  if (s.reason === 'qber-exceeded') {
    if (typeof s.qber === 'number') {
      state.qber = s.qber;
      state.qberHistory.push(s.qber);
      if (state.qberHistory.length > QBER_HISTORY_CAP) state.qberHistory.shift();
    }
    logEvent(EVENT.qberAbort, { qber: s.qber ?? null });
    showToast('QBER above the 11% threshold — frame rejected.');
  } else if (s.reason === 'setup') {
    state.cipherState = 'compromised';
    showToast('Secure-channel setup failed — no key will be established.');
  } else if (s.reason === 'timeout') {
    // A silent stretch; the session restarts on its own. No alarm.
  } else {
    // integrity / protocol / divergence: tampering OR an ordinary fault
    // (dropped message, version skew) — never assert MITM from one event.
    showToast('Channel integrity check failed — tampering or a connection fault. Recovering.');
  }
}

/* ── Optical bench (hardware daemon) ────────────────────────────── */

/** Load the persisted optical-mode settings (per-origin). */
function loadOpticalSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTICAL_STORAGE_KEY) || '{}');
    // Token from sessionStorage, else any token left in the localStorage blob
    // (which is then rewritten without it).
    let token = '';
    try {
      token = sessionStorage.getItem(OPTICAL_TOKEN_KEY) || '';
    } catch {
      /* sessionStorage unavailable — no token this session */
    }
    if (!token && typeof saved.token === 'string') token = saved.token;
    state.optical = {
      enabled: !!saved.enabled,
      url: typeof saved.url === 'string' && saved.url ? saved.url : state.optical.url,
      token,
    };
    if (saved.token) saveOpticalSettings(); // rewrite without the token at rest
  } catch {
    /* corrupt or unavailable storage — keep the defaults */
  }
}

function saveOpticalSettings() {
  // Persist non-secret settings only; the token is never written to
  // localStorage.
  try {
    localStorage.setItem(
      OPTICAL_STORAGE_KEY,
      JSON.stringify({ enabled: state.optical.enabled, url: state.optical.url }),
    );
  } catch {
    /* storage blocked — settings just won't persist */
  }
  try {
    if (state.optical.token) {
      sessionStorage.setItem(OPTICAL_TOKEN_KEY, state.optical.token);
    } else {
      sessionStorage.removeItem(OPTICAL_TOKEN_KEY);
    }
  } catch {
    /* sessionStorage blocked — token just won't persist across reloads */
  }
}

/** Toggle the optical-bench checkbox from the lobby settings row. */
function toggleOptical(enabled) {
  state.optical.enabled = !!enabled;
  saveOpticalSettings();
  render();
}

/** Persist the daemon URL / token as the user edits them. */
function setOpticalField(field, value) {
  if (field === 'url' || field === 'token') {
    state.optical[field] = value;
    saveOpticalSettings();
  }
}

/**
 * If optical mode is enabled, pair with the local daemon and hand the
 * orchestrator a bench backend so negotiation can offer optical. Any failure
 * (no daemon, bad token, refused) is caught and left to fall back to the
 * simulator with a visible notice — the call is never broken by it.
 */
async function connectOpticalBenchIfEnabled() {
  benchConnection = null;
  if (!state.optical.enabled || !state.optical.token) return;
  try {
    const { DaemonConnection, DaemonFrameSource } = await import('./js/bench/daemon-source.js');
    const conn = new DaemonConnection({ url: state.optical.url, token: state.optical.token });
    await conn.connect();
    benchConnection = conn;
    bb84.configureBench({
      backend: 'bench',
      role: conn.role,
      connect: async () => {},
      makeFrameSource: () => new DaemonFrameSource(conn),
    });
    state.opticalStatus = `paired (${conn.role})`;
  } catch (err) {
    benchConnection = null;
    state.opticalStatus = 'unavailable';
    showToast(`Optical bench unavailable (${err.message}) — using the simulator.`);
  }
}

/** Security status of the most recent frame, as a `.qd-status--*` suffix. */
function qberStatus() {
  if (state.qber === null) return 'normal';
  if (state.qber > QBER_THRESHOLD) return 'danger';
  if (state.qber > QBER_WARNING) return 'warning';
  return 'normal';
}

/**
 * Channel-quality label for the QBER badge — a link readout ("how noisy is the
 * quantum channel"), NOT a safety verdict. The cipher pill is the single source
 * of truth for whether the call is encrypted; a QBER spike raises errors and
 * rejects frames but the last good key keeps the media safe.
 */
function qberStatusLabel() {
  if (state.qber === null) return 'Measuring…';
  if (state.qber > QBER_THRESHOLD) return 'Very noisy';
  if (state.qber > QBER_WARNING) return 'Noisy';
  return 'Clean';
}

/** Backend badge text — never claims photons the backend didn't produce. */
function modeBadge() {
  if (state.mode === 'optical') return 'OPTICAL';
  return 'SIMULATED';
}

/** Reservoir fill fraction (0-1) toward the key currently being distilled. */
function distillFraction() {
  if (!state.mintBudget || state.mintBudget <= 0) return 0;
  return Math.min(1, state.reservoirBits / state.mintBudget);
}

/**
 * A compact live media-diagnostics line: the adaptive tier, the browser's own
 * bandwidth estimate, RTT, what is currently capping quality (bandwidth/cpu —
 * the throughput limiter), and per-frame encrypt/decrypt time from the crypto
 * worker. Empty until the first telemetry arrives. This is what makes the
 * throughput bottleneck observable rather than guessed.
 */
function netDiagLine() {
  const q = state.quality;
  const c = state.cryptoMetrics;
  const parts = [];
  if (q) {
    if (q.tier) parts.push(`Tier ${q.tier}`);
    if (q.bandwidthKbps != null) parts.push(`${q.bandwidthKbps.toLocaleString()} kbps est`);
    if (q.rttMs != null) parts.push(`${q.rttMs} ms RTT`);
    if (q.limitedBy && q.limitedBy !== 'none') parts.push(`limited by ${q.limitedBy}`);
  }
  if (c && (c.encryptLatencyUs || c.decryptLatencyUs)) {
    const enc = c.encryptLatencyUs ? Math.round(c.encryptLatencyUs) : '–';
    const dec = c.decryptLatencyUs ? Math.round(c.decryptLatencyUs) : '–';
    parts.push(`crypto ${enc}/${dec} µs`);
  }
  if (parts.length === 0) return '';
  return `<div class="qd-diag" title="Live media diagnostics — adaptive tier, the browser's own send-bandwidth estimate, round-trip time, what is capping quality (bandwidth or CPU), and per-frame encrypt/decrypt time.">${parts.join(' · ')}</div>`;
}

/**
 * Toggle the simulated intercept-resend eavesdropper. The reservoir engine
 * applies it to the next frame and, if the channel had latched, clears the
 * latch so recovery to green is visible. Only the source side (the initiator
 * in simulated mode) sees this control — it owns the simulated channel.
 */
function toggleEavesdropper() {
  if (!bb84) return;
  state.eavesdropper = !state.eavesdropper;
  bb84.setEavesdropper(state.eavesdropper);
  logEvent(EVENT.eve, { active: state.eavesdropper });
  // Tell the peer this is a demo, so their QBER spike comes with an explanation.
  if (socket) socket.emit('eve_demo', { active: state.eavesdropper });
  showToast(
    state.eavesdropper
      ? 'Eavesdropper on — intercepting and resending qubits. Watch the QBER climb.'
      : 'Eavesdropper removed — the channel returns to normal noise.',
    state.eavesdropper ? 'error' : 'success',
  );
  render();
}

/** Per-frame QBER strip chart with the 11% abort threshold drawn in. */
function drawQberChart() {
  const c = document.getElementById('qd-chart');
  if (!c) return;
  const w = c.clientWidth || 300;
  const h = c.clientHeight || 60;
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr;
  c.height = h * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const colorFor = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
  const pad = 4;
  const history = state.qberHistory;
  // Always keep the threshold comfortably on-screen so the line means something.
  const peak = Math.max(QBER_THRESHOLD * 1.6, ...history);
  const y = (q) => pad + (1 - q / peak) * (h - pad * 2);

  // Threshold line — above this, BB84 discards the key.
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = colorFor('--error', '#ea6962');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, y(QBER_THRESHOLD));
  ctx.lineTo(w - pad, y(QBER_THRESHOLD));
  ctx.stroke();
  ctx.setLineDash([]);

  if (history.length === 0) return;
  const step = history.length > 1 ? (w - pad * 2) / (history.length - 1) : 0;
  const x = (i) => (history.length > 1 ? pad + i * step : w / 2);

  ctx.strokeStyle = colorFor('--success', '#a9b665');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  history.forEach((q, i) => (i === 0 ? ctx.moveTo(x(i), y(q)) : ctx.lineTo(x(i), y(q))));
  ctx.stroke();

  // Points above the threshold are the rejected rounds — mark them.
  history.forEach((q, i) => {
    ctx.fillStyle =
      q > QBER_THRESHOLD ? colorFor('--error', '#ea6962') : colorFor('--success', '#a9b665');
    ctx.beginPath();
    ctx.arc(x(i), y(q), 2, 0, Math.PI * 2);
    ctx.fill();
  });
}

/* ── Video ──────────────────────────────────────────────────────── */
function showLocalVideo(s) {
  const v = document.getElementById('local-video');
  if (v) {
    v.srcObject = s;
    v.play().catch(() => {});
  }
}
function showRemoteVideo(s) {
  // render() replaces the <video> on every state change and re-attaches this
  // stored stream, or the remote video would go black.
  remoteStream = s;
  const v = document.getElementById('remote-video');
  if (v) {
    v.srcObject = s;
    v.play().catch(() => {});
  }
}
function clearRemoteVideo() {
  remoteStream = null;
  const v = document.getElementById('remote-video');
  if (v) v.srcObject = null;
}

/* ── Actions ────────────────────────────────────────────────────── */
function toggleCamera() {
  state.cameraOn = !state.cameraOn;
  if (localStream)
    localStream.getVideoTracks().forEach((t) => {
      t.enabled = state.cameraOn;
    });
  render();
}
function toggleMute() {
  state.muted = !state.muted;
  if (localStream)
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !state.muted;
    });
  render();
}

/**
 * Acquire camera + mic, surfacing a denial instead of failing silently.
 * @returns {Promise<boolean>} whether media is ready to proceed.
 */
async function startLocalMedia() {
  try {
    const s = await webrtcManager.getLocalMedia();
    localStream = s;
    state.mediaError = '';
    showLocalVideo(s);
    return true;
  } catch {
    state.mediaError =
      'Camera and microphone access is required. Allow it in your browser’s site settings, then try again.';
    showToast('Camera and microphone access was blocked.', 'error');
    render();
    return false;
  }
}

async function handleCreateRoom() {
  if (!webrtcManager) return;
  state.isInitiator = true; // the creator runs BB84 as Alice
  // Pair the bench BEFORE the peer connects, clear of the DataChannel bootstrap.
  await connectOpticalBenchIfEnabled();
  if (!(await startLocalMedia())) return;
  webrtcManager.createRoom();
}

/** Whether a key was ever installed this session (derived, not tracked). */
function hasBeenEncrypted() {
  return state.keyIndex !== null;
}

/** Escape a string for safe interpolation into an HTML attribute value. */
function escapeAttr(s) {
  return String(s).replace(/[&"'<>]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Extract the room token from a pasted invite link, a bare fragment, or a
 * bare token. The one parser for both the page-load bootstrap and the Join
 * form. Tokens are url-safe base64 from secrets.token_urlsafe (>= 16 chars);
 * anything after the first invalid character (trailing prose, punctuation a
 * chat client glued on) is trimmed, and a short/invalid candidate yields ''.
 */
function parseRoomToken(text) {
  let candidate = text || '';
  const marker = candidate.indexOf('#room=');
  if (marker !== -1) {
    try {
      candidate = decodeURIComponent(candidate.slice(marker + '#room='.length));
    } catch {
      return '';
    }
  }
  const token = candidate.trim().match(/^[A-Za-z0-9_-]{16,}/);
  return token ? token[0] : '';
}

async function handleJoinRoom(e) {
  e.preventDefault();
  const input = document.getElementById('room-input');
  const id = parseRoomToken(input ? input.value.trim() : '');
  if (!id) {
    showToast('Paste an invite link to join.', 'error');
    return;
  }
  if (!webrtcManager) return;
  state.isInitiator = false; // the joiner runs BB84 as Bob
  // Pair the bench BEFORE connecting, clear of the DataChannel bootstrap.
  await connectOpticalBenchIfEnabled();
  if (!(await startLocalMedia())) return;
  state.joining = true; // show "Connecting…" until the peer stream arrives
  render();
  webrtcManager.joinRoom(id);
}

/** Expand/collapse the BB84 telemetry so the video stays the anchor. */
function toggleDashboard() {
  state.dashboardExpanded = !state.dashboardExpanded;
  render();
}

/** The user compared the SAS on camera and it MATCHES — mark the call verified. */
function handleSasVerify() {
  state.sasVerified = true;
  logEvent(EVENT.sasVerified);
  showToast('Identity verified — this call is end-to-end secure.', 'success');
  render();
}

/** The user compared the SAS on camera and it differs — treat as MITM. */
function handleSasMismatch() {
  showToast('Code mismatch reported — ending the call. Do not trust this channel.', 'error');
  handleLeave();
}

function copyJoinLink() {
  if (!state.joinLink) return;
  navigator.clipboard
    .writeText(state.joinLink)
    .then(() => showToast('Invite link copied — send it to your partner.', 'success'))
    .catch(() => showToast('Copy failed — select the link text manually.', 'error'));
}

/** Clear per-session state — also stops BB84 retries and the encryption indicator. */
/** Start adaptive quality once the call is up (idempotent). */
function startQualityController() {
  if (qualityController || !QualityControllerCls || !webrtcManager) return;
  const pc = webrtcManager.peerConnection;
  if (!pc || !localStream) return;
  qualityController = new QualityControllerCls({
    pc,
    localStream,
    sender: webrtcManager.videoSender,
    onUpdate: (q) => {
      state.quality = q;
      render();
    },
  });
  qualityController.start();
}

function stopQualityController() {
  if (qualityController) {
    qualityController.stop();
    qualityController = null;
  }
  state.quality = null;
}

/* ── Analytics telemetry bus (second-window demo screen) ─────────── */

/** Wire the BroadcastChannel: publish snapshots out, accept demo commands in. */
function setupTelemetryBus(channelName, isValidCommand) {
  if (typeof BroadcastChannel === 'undefined') return; // older browser: no feed
  telemetryBus = new BroadcastChannel(channelName);
  telemetryBus.onmessage = (e) => {
    if (isValidCommand(e.data)) handleAnalyticsCommand(e.data.cmd);
  };
}

/** Publish one live telemetry snapshot (real data only; no-op before wiring). */
function publishTelemetry() {
  if (!telemetryBus || !buildSnapshot) return;
  const snap = buildSnapshot(state, {
    fingerprints: webrtcManager ? webrtcManager.getDtlsFingerprints() : null,
    events: eventLog ? eventLog.tail() : [],
    qberThreshold: QBER_THRESHOLD,
    qberWarning: QBER_WARNING,
  });
  try {
    telemetryBus.postMessage(snap);
  } catch {
    /* structured-clone failure — skip this tick */
  }
}

/** Record a timeline event and publish immediately so the timeline is prompt. */
function logEvent(kind, detail = null) {
  if (eventLog) eventLog.log(kind, detail);
  publishTelemetry();
}

/** Coalesced ~4/s publisher while a call is up (events publish on their own). */
function startTelemetryPublisher() {
  if (telemetryTimer || !telemetryBus) return;
  publishTelemetry();
  telemetryTimer = setInterval(publishTelemetry, 250);
}

function stopTelemetryPublisher() {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
  publishTelemetry(); // one final snapshot — inCall is now false → live panels clear
}

/**
 * Publish a post-call summary snapshot from the still-populated state, flagged
 * so the analytics window latches it while its live panels reset. Called at the
 * top of resetSession, before the counters are zeroed.
 */
function publishCallSummary() {
  if (!telemetryBus || !buildSnapshot) return;
  const snap = buildSnapshot(state, {
    fingerprints: webrtcManager ? webrtcManager.getDtlsFingerprints() : null,
    events: eventLog ? eventLog.tail() : [],
    qberThreshold: QBER_THRESHOLD,
    qberWarning: QBER_WARNING,
  });
  snap.inCall = false;
  snap.summary = true;
  try {
    telemetryBus.postMessage(snap);
  } catch {
    /* skip */
  }
}

/** Apply an allowlisted demo command from the analytics window. */
function handleAnalyticsCommand(cmd) {
  if (cmd === 'toggle-eve') {
    // Mirror the in-call UI gate: the eavesdropper toggle is initiator-only.
    if (state.isInitiator) toggleEavesdropper();
  } else if (cmd === 'force-rotate') {
    if (bb84) bb84.forceRotate();
  } else if (cmd === 'reset') {
    handleLeave();
  }
}

/** Open the analytics screen in its own window (fed live over the bus). */
function openAnalytics() {
  window.open('analytics.html', 'qvc-analytics', 'width=1280,height=860');
}

function resetSession() {
  stopQualityController();
  // Emit the post-call summary while the totals are still populated, then let
  // the publisher stop (which clears the analytics window's live panels).
  if (state.peerConnected) {
    logEvent(EVENT.callEnd);
    publishCallSummary();
  }
  if (bb84) bb84.destroy();
  if (benchConnection) {
    benchConnection.close();
    benchConnection = null;
  }
  state.mode = null;
  state.peerConnected = false;
  state.roomId = '';
  state.waitingForPeer = false;
  state.bb84Active = false;
  state.qber = null;
  state.qberHistory = [];
  state.keyIndex = null;
  state.mode = null;
  state.reservoirBits = 0;
  state.mintBudget = null;
  state.keysMinted = 0;
  state.rotations = 0;
  state.poolDepth = 0;
  state.lastDetections = null;
  state.cipherState = 'establishing';
  state.joinLink = '';
  state.sas = null;
  state.eavesdropper = false;
  state.sasVerified = false;
  state.joining = false;
  state.reconnecting = false;
  state.peerEavesdropping = false;
  stopTimer();
  stopTelemetryPublisher();
  if (eventLog) eventLog.clear();
  clearRemoteVideo();
  // Release the camera/mic so the indicator light goes off after the call.
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
}

function handleLeave() {
  if (webrtcManager) webrtcManager.leave();
  resetSession();
  render();
}

/* ── Timer ──────────────────────────────────────────────────────── */
function startTimer() {
  stopTimer();
  state.elapsed = 0;
  elapsedInterval = setInterval(() => {
    state.elapsed++;
    const el = document.getElementById('timer');
    if (el) el.textContent = fmtTime(state.elapsed);
  }, 1000);
}
function stopTimer() {
  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
}
function fmtTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/* ── Toast ──────────────────────────────────────────────────────── */
let toastTimer = null;
/** Show a transient message. tone: 'info' (default) | 'success' | 'error'. */
function showToast(msg, tone = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast toast--' + tone; // reset tone classes, keep base
  void el.offsetWidth; // reflow so a rapid re-toast still animates in
  el.classList.add('toast--visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('toast--visible'), 5000);
}

/* ── Theme ──────────────────────────────────────────────────────── */
function getTheme() {
  return localStorage.getItem('qvc-theme') || 'light';
}
function setTheme(t) {
  localStorage.setItem('qvc-theme', t);
  document.documentElement.dataset.theme = t;
}

/** Always-visible cipher pill — worker truth, not UI assumption. */
function cipherPill() {
  const views = {
    establishing: { mod: 'establishing', label: 'Establishing encryption…' },
    encrypted: {
      mod: 'encrypted',
      label: `Encrypted · AES-GCM${state.keyIndex !== null ? ` #${state.keyIndex}` : ''}`,
    },
    unencrypted: { mod: 'unencrypted', label: 'Not encrypted — media blocked' },
    compromised: { mod: 'compromised', label: 'Channel integrity lost' },
    unsupported: {
      mod: 'unsupported',
      label: 'Encryption unsupported — try Chrome, Firefox, or Safari 17+',
    },
  };
  const v = views[state.cipherState] || views.establishing;
  return `<span class="cipher-pill cipher-pill--${v.mod}">${v.label}</span>`;
}

/* ── Render ─────────────────────────────────────────────────────── */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const inCall = state.peerConnected;

  if (!inCall) {
    // Re-renders happen while the user types (signaling status, toasts); read
    // the field back first so innerHTML replacement never eats their input.
    const typedRoomValue = document.getElementById('room-input')?.value ?? '';
    app.innerHTML = `
      <div class="header">
        <h1>QKD Video Chat</h1>
        <div class="header-right">
          <button class="analytics-btn" onclick="openAnalytics()" title="Open the live analytics screen in a new window">${ICONS.analytics}<span>Analytics</span></button>
          <div class="status"><span class="dot ${state.signalingConnected ? 'dot--ok' : 'dot--off'}"></span>${state.signalingConnected ? 'Connected' : 'Offline'}</div>
        </div>
      </div>
      <div class="lobby">
        <div class="lobby-card">
        <div class="lobby-hero">
          <h2 class="lobby-title">Quantum-secured video</h2>
          <p class="lobby-intro">A peer-to-peer call whose encryption keys come from BB84 quantum key distribution. Start a session and share the link, or paste an invite to join.</p>
        </div>
        <div class="preview"><video id="local-video" class="preview-video" autoplay muted playsinline></video><span class="video-label">You</span></div>
        <div class="lobby-actions">
          ${
            state.joining
              ? `<div class="lobby-waiting"><span class="lobby-waiting-spinner"></span><span>Connecting securely…</span></div>`
              : state.waitingForPeer
                ? `<div class="lobby-waiting"><span class="lobby-waiting-spinner"></span><span>Waiting for your partner to join…</span></div>
          <div class="invite">
            <input id="invite-link" class="invite-link" type="text" readonly onclick="this.select()">
            <button class="btn" onclick="copyJoinLink()">Copy link</button>
          </div>
          <p class="lobby-hint">Send this link to the person you want to call.</p>`
                : `${state.invited ? `<p class="lobby-invited">You’ve been invited to a call — join below, or start your own.</p>` : ''}
          <button class="btn ${state.invited ? '' : 'btn--primary'}" onclick="handleCreateRoom()" ${!state.signalingConnected ? 'disabled' : ''}>Start Session</button>
          ${state.mediaError ? `<div class="form-error">${state.mediaError}</div>` : ''}
          <form onsubmit="handleJoinRoom(event)" class="join-form">
            <input id="room-input" type="text" placeholder="Paste invite link" autocomplete="off" ${!state.signalingConnected ? 'disabled' : ''}>
            <button type="submit" class="btn ${state.invited ? 'btn--primary' : ''}" ${!state.signalingConnected ? 'disabled' : ''}>Join</button>
          </form>
          <div class="optical">
            <label class="optical-toggle">
              <input type="checkbox" ${state.optical.enabled ? 'checked' : ''} onchange="toggleOptical(this.checked)">
              <span>Use optical bench (hardware daemon)</span>
            </label>
            ${
              state.optical.enabled
                ? `<div class="optical-fields">
              <input id="optical-url" class="optical-input" type="text" placeholder="ws://127.0.0.1:8781" value="${escapeAttr(state.optical.url)}" oninput="setOpticalField('url', this.value)">
              <input id="optical-token" class="optical-input" type="password" placeholder="Pairing token (from daemon)" oninput="setOpticalField('token', this.value)">
              <span class="optical-hint">Both peers need a bench for optical mode; otherwise the call uses the simulator.</span>
              ${state.opticalStatus ? `<span class="optical-status ${state.opticalStatus === 'unavailable' ? 'optical-status--error' : ''}">Daemon: ${state.opticalStatus}</span>` : ''}
            </div>`
                : ''
            }
          </div>`
          }
        </div>
        <div class="media-controls">
          <button class="media-btn ${state.cameraOn ? '' : 'media-btn--off'}" onclick="toggleCamera()">${state.cameraOn ? ICONS.cameraOn : ICONS.cameraOff}</button>
          <button class="media-btn ${state.muted ? 'media-btn--off' : ''}" onclick="toggleMute()">${state.muted ? ICONS.micOff : ICONS.micOn}</button>
        </div>
        </div>
      </div>
      <div id="toast" class="toast"></div>`;
    // Token and link go through value/textContent sinks, never innerHTML.
    const invite = document.getElementById('invite-link');
    if (invite) invite.value = state.joinLink;
    const roomInput = document.getElementById('room-input');
    if (roomInput) {
      if (typedRoomValue) {
        roomInput.value = typedRoomValue;
      } else if (pendingRoomToken) {
        // Invite-link prefill applies once, and never over the user's typing.
        roomInput.value = pendingRoomToken;
        pendingRoomToken = '';
      }
    }
    // The pairing token is a credential: restore it through the value sink so
    // it never lives in the rendered HTML string.
    const tokenInput = document.getElementById('optical-token');
    if (tokenInput) tokenInput.value = state.optical.token;
    if (localStream) {
      const v = document.getElementById('local-video');
      if (v) {
        v.srcObject = localStream;
        v.play().catch(() => {});
      }
    }
  } else {
    app.innerHTML = `
      <div class="incall">
        <div class="video-area">
          ${remoteStream ? '<span class="video-label">Partner</span>' : `<div class="video-placeholder">Waiting for your partner’s camera…</div>`}
          <video id="remote-video" class="remote-video" autoplay playsinline></video>
          <video id="local-video" class="pip-video" autoplay muted playsinline></video>
        </div>
        ${state.reconnecting ? `<div class="banner banner--warn"><span class="banner-spinner"></span>Reconnecting…</div>` : ''}
        <div class="call-info"><span>Room <strong id="room-ref"></strong></span>${cipherPill()}${state.sasVerified ? '<span class="verified-badge">✓ Verified</span>' : ''}<span id="timer">${fmtTime(state.elapsed)}</span></div>
        ${
          state.peerEavesdropping && !state.isInitiator
            ? `<div class="banner banner--info">Your partner is running the eavesdropper demo — the rising QBER is expected, not a real attack.</div>`
            : ''
        }
        ${
          state.sas
            ? state.sasVerified
              ? `<div class="sas sas--verified">
          <span class="sas-emoji">${state.sas.emoji.join(' ')}</span>
          <strong class="sas-digits" id="sas-digits"></strong>
          <span class="sas-hint">Verified on camera — no one is between you.</span>
        </div>`
              : `<div class="sas">
          <span class="sas-emoji">${state.sas.emoji.join(' ')}</span>
          <strong class="sas-digits" id="sas-digits"></strong>
          <span class="sas-hint">Compare on camera. If the emoji or digits differ, someone is between you — hang up.</span>
          <div class="sas-actions">
            <button class="btn-verify" onclick="handleSasVerify()">Matches — verify</button>
            <button class="sas-mismatch" onclick="handleSasMismatch()">Doesn't match</button>
          </div>
        </div>`
            : ''
        }
        <div id="quantum-panel" class="quantum-panel">
          ${
            state.bb84Active
              ? `
            <button class="qd-toggle" onclick="toggleDashboard()" aria-expanded="${state.dashboardExpanded}">
              <span class="qd-title" title="BB84 — the quantum key-distribution protocol that generates this call's encryption keys.">BB84 Key Reservoir</span>
              <span class="qd-mode qd-mode--${state.mode || 'pending'}" title="Whether keys come from a real optical bench or the in-browser simulator.">${modeBadge()}</span>
              <span class="qd-badge qd-status--${qberStatus()}" title="Quantum channel noise. This is a link-quality readout, not the encryption status — that's the pill above.">${qberStatusLabel()}</span>
              <span class="qd-summary">${state.keysMinted} ${state.keysMinted === 1 ? 'key' : 'keys'}</span>
              <span class="qd-chevron">${state.dashboardExpanded ? '▾' : '▸'}</span>
            </button>
            ${
              state.dashboardExpanded
                ? `<div class="qd-body">
            <div class="qd-distill">
              <div class="qd-distill-bar"><span class="qd-distill-fill ${state.qber !== null && state.qber > QBER_THRESHOLD ? 'qd-distill-fill--stalled' : ''}" style="width:${(distillFraction() * 100).toFixed(0)}%"></span></div>
              <span class="qd-distill-label" title="Sifted bits accumulated toward the next key; a noisy channel discards frames and slows this.">Distilling next key — ${state.reservoirBits.toLocaleString()}${state.mintBudget ? ` / ${state.mintBudget.toLocaleString()}` : ''} sifted bits</span>
            </div>
            <div class="qd-metrics">
              <div class="qd-metric" title="Quantum bit error rate — how often a test bit disagrees. A spike above 11% aborts the batch (noise or eavesdropping)."><span class="qd-metric-value ${state.qber !== null && state.qber > QBER_THRESHOLD ? 'qd-metric--danger' : state.qber !== null && state.qber > QBER_WARNING ? 'qd-metric--warning' : ''}">${state.qber !== null ? (state.qber * 100).toFixed(1) + '%' : '--'}</span><span class="qd-metric-label">QBER</span></div>
              <div class="qd-metric" title="Encryption keys minted this call."><span class="qd-metric-value">${state.keysMinted}</span><span class="qd-metric-label">Keys</span></div>
              <div class="qd-metric" title="Times the media encryption key has rotated to a fresh one."><span class="qd-metric-value">${state.rotations}</span><span class="qd-metric-label">Rotations</span></div>
              <div class="qd-metric" title="Keys buffered and ready to rotate in."><span class="qd-metric-value">${state.poolDepth}</span><span class="qd-metric-label">Pool</span></div>
            </div>
            <canvas id="qd-chart" class="qd-chart"></canvas>
            ${netDiagLine()}
            ${state.isInitiator ? `<button class="qd-eve-btn ${state.eavesdropper ? 'qd-eve-btn--active' : ''}" onclick="toggleEavesdropper()">${state.eavesdropper ? 'Eavesdropper active — click to remove' : 'Simulate eavesdropper'}</button>` : ''}
          </div>`
                : ''
            }`
              : '<div class="qd-inactive">Establishing quantum channel…</div>'
          }
        </div>
        <div class="toolbar">
          <button class="media-btn ${state.cameraOn ? '' : 'media-btn--off'}" onclick="toggleCamera()">${state.cameraOn ? ICONS.cameraOn : ICONS.cameraOff}</button>
          <button class="media-btn ${state.muted ? 'media-btn--off' : ''}" onclick="toggleMute()">${state.muted ? ICONS.micOff : ICONS.micOn}</button>
          <button class="media-btn" onclick="openAnalytics()" title="Open the live analytics screen in a new window">${ICONS.analytics}</button>
          <button class="btn btn--danger" onclick="handleLeave()">${ICONS.phoneOff} Leave</button>
        </div>
      </div>
      <div id="toast" class="toast"></div>`;
    const roomRef = document.getElementById('room-ref');
    if (roomRef) roomRef.textContent = state.roomId ? `${state.roomId.slice(0, 4)}\u2026` : '';
    const sasDigits = document.getElementById('sas-digits');
    if (sasDigits && state.sas) sasDigits.textContent = state.sas.digits;
    if (remoteStream) {
      const rv = document.getElementById('remote-video');
      if (rv) {
        rv.srcObject = remoteStream;
        rv.play().catch(() => {});
      }
    }
    if (localStream) {
      const v = document.getElementById('local-video');
      if (v) {
        v.srcObject = localStream;
        v.play().catch(() => {});
      }
    }
    if (state.bb84Active) drawQberChart();
  }
}

/* ── Init ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setTheme(getTheme());
  loadOpticalSettings();
  pendingRoomToken = parseRoomToken(window.location.hash);
  state.invited = !!pendingRoomToken; // arrived via an invite link → promote Join
  connectToSignaling(window.QVC_SIGNALING_URL || window.location.origin);
  render();
});

window.handleCreateRoom = handleCreateRoom;
window.handleJoinRoom = handleJoinRoom;
window.handleLeave = handleLeave;
window.toggleCamera = toggleCamera;
window.toggleMute = toggleMute;
window.toggleEavesdropper = toggleEavesdropper;
window.copyJoinLink = copyJoinLink;
window.toggleDashboard = toggleDashboard;
window.handleSasVerify = handleSasVerify;
window.handleSasMismatch = handleSasMismatch;
window.toggleOptical = toggleOptical;
window.setOpticalField = setOpticalField;
window.openAnalytics = openAnalytics;
