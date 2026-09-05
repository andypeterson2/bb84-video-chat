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
  qberHistory: [],
  keyBudget: 0,
  keyIndex: null,
  // Worker-reported cipher truth: 'establishing' | 'encrypted' | 'unencrypted'
  // | 'compromised' (re-key exhausted; last good key still active). Driven only
  // by cipher-state messages from the crypto worker (or BB84 giving up) —
  // never assumed from the UI's own bookkeeping.
  cipherState: 'establishing',
  joinLink: '',
  sas: null, // {digits, emoji[]} — frozen after the first authenticated round
  eavesdropper: false,
  pipeline: [], // live BB84 step progress for the current round (see freshPipeline)
  errorMessage: '',
};

// The BB84 round as an ordered pipeline, surfaced live so a viewer can watch a
// key being distilled: photons sent → basis-sifted → error-sampled → corrected
// → privacy-amplified into the final key.
const PIPELINE_STEPS = [
  { key: 'transmit', label: 'Transmit' },
  { key: 'sift', label: 'Sift' },
  { key: 'qber', label: 'QBER' },
  { key: 'correct', label: 'Correct' },
  { key: 'amplify', label: 'Amplify' },
];
function freshPipeline() {
  return PIPELINE_STEPS.map((s) => ({ ...s, status: 'pending', detail: '' }));
}

/** BB84 aborts above this QBER — intercept-resend lands near 25%. */
const QBER_THRESHOLD = 0.11;
/** Below the abort threshold but above ordinary channel noise. */
const QBER_WARNING = 0.08;

// Room token arriving via an invite link's #room= fragment (prefills Join).
let pendingRoomToken = '';

let elapsedInterval = null;
let socket = null;
let webrtcManager = null;
let metricsCollector = null;
let localStream = null;
let bb84 = null;

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
};

/* ── Signaling ──────────────────────────────────────────────────── */

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

  Promise.all([import('./js/webrtc.js'), import('./js/bb84/orchestrator.js')]).then(
    ([{ WebRTCManager }, { BB84Orchestrator }]) => {
      // Attach the Insertable Streams transforms up front. The crypto worker is
      // FAIL-CLOSED: it drops every frame until BB84 delivers a key, then encrypts
      // with no renegotiation. (Constructing with `false` never created the worker
      // at all, so a derived key had nowhere to go — encryption never engaged.)
      webrtcManager = new WebRTCManager(socket, { enableEncryption: true });

      // stepDelayMs paces the pipeline so each phase is visible on camera — a raw
      // round completes in well under a second. It only affects presentation.
      bb84 = new BB84Orchestrator({
        webrtcManager,
        onStateChange: handleBB84State,
        stepDelayMs: 500,
      });

      webrtcManager.on('room-created', (d) => {
        state.roomId = d.room_id;
        // The room id is an unguessable capability token: the invite link IS
        // the credential. It travels in the fragment so it never reaches
        // server logs or Referer headers.
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
        state.elapsed = 0;
        startTimer();
        showRemoteVideo(d.stream);
        render();
      });
      webrtcManager.on('data-channel-open', () => {
        state.bb84Active = true;
        render();
        // The DataChannel carries BB84's quantum + classical messages. The room
        // creator runs the protocol as Alice; the joiner runs as Bob whenever
        // the creator announces a round (it never self-starts, so an injected
        // round-start can't wedge it into a phantom round). The room's
        // capability token doubles as the channel-authentication secret.
        bb84
          .init({ roomToken: state.roomId, isInitiator: state.isInitiator })
          .then(() => {
            if (state.isInitiator) bb84.runRound(true);
          })
          .catch(() => {
            // Auth bootstrap failed (fingerprints/HKDF): no round may run.
            // Loud red state, never a silent fall-through to "establishing".
            state.cipherState = 'compromised';
            showToast('Secure-channel setup failed — no key will be established.');
            render();
          });
      });
      webrtcManager.on('data-channel-message', (d) => bb84.handleMessage(d));
      webrtcManager.on('peer-disconnected', () => {
        resetSession();
        render();
        showToast('Peer disconnected.');
      });
      webrtcManager.on('error', (d) => showToast(d.message || 'Error'));
      webrtcManager.on('state-change', (d) => {
        state.peerConnected = d.state === 'connected';
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
          // This browser has no RTCRtpScriptTransform: frames CANNOT be
          // encrypted, and pretending otherwise is exactly the lie the
          // fail-closed design exists to prevent.
          state.cipherState = 'unsupported';
          showToast('This browser cannot encrypt media frames — no key will be used.');
        } else if (msg.state === 'keyless') {
          // The worker is dropping frames. Before the first key that is the
          // normal establishing window; after one it means the keyed worker
          // was replaced — a downgrade, shown loudly.
          state.cipherState = hasBeenEncrypted() ? 'unencrypted' : 'establishing';
        }
        render();
      });
      // Aggregated by the worker (at most one message per second). A burst of
      // failures during a re-key is normal; a sustained stream is not.
      webrtcManager.on('decrypt-error', (msg) => {
        console.warn(`Frame decrypt failures in the last interval: ${msg.failures ?? 1}`);
      });
    },
  );

  import('./js/metrics.js').then(({ MetricsCollector }) => {
    metricsCollector = new MetricsCollector();
    metricsCollector.subscribe('qber-exceeded', () =>
      showToast('QBER exceeded — possible eavesdropper!'),
    );
    metricsCollector.subscribe('key-budget-low', () => {
      if (webrtcManager) startBB84Round();
    });
  });
}

/* ── BB84 ───────────────────────────────────────────────────────── */

/**
 * Orchestrator lifecycle → UI. A completed round means the derived key is already
 * installed in the Insertable Streams crypto worker, so every frame from here on is
 * AES-128-GCM encrypted under a BB84 key. A failed round means the QBER exceeded the
 * 11% security threshold — the key is discarded and the orchestrator re-keys.
 */
function handleBB84State(s) {
  if (s.phase === 'running') {
    // New round — reset the pipeline and light up the first step.
    state.pipeline = freshPipeline();
    setStep('transmit', 'active');
  } else if (s.phase === 'progress') {
    applyPipelineProgress(s);
  } else if (s.phase === 'complete') {
    state.qber = s.qber;
    state.qberHistory.push(s.qber);
    state.keyBudget = (s.metrics && s.metrics.keyLength) || 0;
    state.keyIndex = s.keyIndex;
    if (s.sas) state.sas = s.sas;
    state.pipeline.forEach((st) => {
      if (st.status !== 'failed') st.status = 'done';
    });
  } else if (s.phase === 'failed') {
    if (s.reason === 'integrity') {
      // A MAC/sequence/fingerprint check failed. That is tampering OR an
      // ordinary fault (dropped message, version skew) — never assert MITM
      // as fact on one event. The orchestrator retries; persistent failure
      // arrives below as 'exhausted' and goes red there.
      showToast('Channel integrity check failed — tampering or a connection fault. Retrying.');
    } else {
      if (typeof s.qber === 'number') {
        state.qber = s.qber;
        state.qberHistory.push(s.qber);
      }
      setStep('qber', 'failed');
      showToast('QBER above the 11% threshold — key rejected, re-keying.');
    }
  } else if (s.phase === 'error') {
    showToast('Key exchange error — retrying.');
  } else if (s.phase === 'exhausted') {
    // Out of retries. Frames still ride the LAST good key (the worker never
    // downgrades), but no fresh key is obtainable on this channel — show it
    // red and leave the decision to the user.
    state.cipherState = 'compromised';
    showToast('Channel integrity lost — tampering or a persistent fault. Leave and retry.');
  }
  render();
}

/** Set a pipeline step's status (and optionally its detail line) by key. */
function setStep(key, status, detail) {
  const st = state.pipeline.find((s) => s.key === key);
  if (!st) return;
  st.status = status;
  if (detail !== undefined) st.detail = detail;
}

/** Mark the step after `key` as active, if it's still pending. */
function activateNext(key) {
  const i = state.pipeline.findIndex((s) => s.key === key);
  const next = state.pipeline[i + 1];
  if (next && next.status === 'pending') next.status = 'active';
}

// A per-phase 'progress' event means that step just finished; render its result
// and light up the next one. The QBER step is special: a value over the
// threshold ends the round there (Correct/Amplify never run), so it goes
// straight to failed rather than done.
function applyPipelineProgress(s) {
  if (s.step === 'abort') {
    setStep('qber', 'failed');
    return;
  }
  const detail = {
    transmit: () => `${s.sent.toLocaleString()} qubits`,
    sift: () => `${s.sifted} / ${s.raw.toLocaleString()}`,
    qber: () => `${(s.qber * 100).toFixed(1)}%`,
    correct: () => `${s.bits} bits`,
    amplify: () => `${s.keyLength}-bit key`,
  }[s.step];
  const text = detail ? detail() : '';
  if (s.step === 'qber' && s.qber > QBER_THRESHOLD) {
    setStep('qber', 'failed', text);
    return;
  }
  setStep(s.step, 'done', text);
  activateNext(s.step);
}

/**
 * Start another key-exchange round (also fired when the key budget runs low).
 * Only the initiator starts rounds; the joiner's orchestrator follows the
 * initiator's round-start announcements.
 */
function startBB84Round() {
  if (bb84 && state.isInitiator) bb84.runRound(true);
}

/** Security status of the most recent round, as a `.qd-status--*` suffix. */
function qberStatus() {
  if (state.qber === null) return 'normal';
  if (state.qber > QBER_THRESHOLD) return 'danger';
  if (state.qber > QBER_WARNING) return 'warning';
  return 'normal';
}

function qberStatusLabel() {
  if (state.qber === null) return 'Exchanging';
  if (state.qber > QBER_THRESHOLD) return 'Compromised';
  if (state.qber > QBER_WARNING) return 'Elevated';
  return 'Secure';
}

/**
 * Toggle the simulated intercept-resend eavesdropper and immediately re-key, so
 * the effect is visible within one round rather than after the retry delay.
 * Only the initiator sees this control — Alice owns the simulated channel.
 */
function toggleEavesdropper() {
  if (!bb84) return;
  state.eavesdropper = !state.eavesdropper;
  bb84.setEavesdropper(state.eavesdropper);
  showToast(
    state.eavesdropper
      ? 'Eve is intercepting and resending qubits — watch the QBER.'
      : 'Eve removed — the channel should return to normal noise.',
  );
  render();
  startBB84Round();
}

/** QBER-per-round sparkline with the 11% abort threshold drawn in. */
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
  const v = document.getElementById('remote-video');
  if (v) {
    v.srcObject = s;
    v.play().catch(() => {});
  }
}
function clearRemoteVideo() {
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

function handleCreateRoom() {
  if (!webrtcManager) return;
  state.isInitiator = true; // the creator runs BB84 as Alice
  webrtcManager.getLocalMedia().then((s) => {
    localStream = s;
    showLocalVideo(s);
    webrtcManager.createRoom();
  });
}

/** Whether a key was ever installed this session (derived, not tracked). */
function hasBeenEncrypted() {
  return state.keyIndex !== null;
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

function handleJoinRoom(e) {
  e.preventDefault();
  const input = document.getElementById('room-input');
  const id = parseRoomToken(input ? input.value.trim() : '');
  if (!id) {
    showToast('Paste an invite link.');
    return;
  }
  if (!webrtcManager) return;
  state.isInitiator = false; // the joiner runs BB84 as Bob
  webrtcManager.getLocalMedia().then((s) => {
    localStream = s;
    showLocalVideo(s);
    webrtcManager.joinRoom(id);
  });
}

/** The user compared the SAS on camera and it differs — treat as MITM. */
function handleSasMismatch() {
  showToast('SAS mismatch reported — tearing down the call. Do not trust this channel.');
  handleLeave();
}

function copyJoinLink() {
  if (!state.joinLink) return;
  navigator.clipboard
    .writeText(state.joinLink)
    .then(() => showToast('Invite link copied — send it to your peer.'))
    .catch(() => showToast('Copy failed — select the link text manually.'));
}

/** Clear per-session state — also stops BB84 retries and the encryption indicator. */
function resetSession() {
  if (bb84) bb84.destroy();
  state.peerConnected = false;
  state.roomId = '';
  state.waitingForPeer = false;
  state.bb84Active = false;
  state.qber = null;
  state.qberHistory = [];
  state.keyBudget = 0;
  state.keyIndex = null;
  state.cipherState = 'establishing';
  state.joinLink = '';
  state.sas = null;
  state.eavesdropper = false;
  state.pipeline = [];
  stopTimer();
  clearRemoteVideo();
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
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 5000);
}

/* ── Theme ──────────────────────────────────────────────────────── */
function getTheme() {
  return localStorage.getItem('qvc-theme') || 'dark';
}
function setTheme(t) {
  localStorage.setItem('qvc-theme', t);
  document.documentElement.dataset.theme = t;
}

/** Red pill states — no security promise may render beside these. */
function pillIsRed() {
  return ['unencrypted', 'compromised', 'unsupported'].includes(state.cipherState);
}

/** Always-visible cipher pill — worker truth, not UI assumption. */
function cipherPill() {
  const views = {
    establishing: { mod: 'establishing', label: 'Establishing encryption…' },
    encrypted: {
      mod: 'encrypted',
      label: `Encrypted · AES-GCM${state.keyIndex !== null ? ` #${state.keyIndex}` : ''}`,
    },
    unencrypted: { mod: 'unencrypted', label: 'NOT ENCRYPTED — media blocked' },
    compromised: { mod: 'unencrypted', label: 'CHANNEL INTEGRITY LOST' },
    unsupported: { mod: 'unencrypted', label: 'ENCRYPTION UNSUPPORTED (browser)' },
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
        <div class="status"><span class="dot ${state.signalingConnected ? 'dot--ok' : 'dot--off'}"></span>${state.signalingConnected ? 'Connected' : 'Offline'}</div>
      </div>
      <div class="lobby">
        <div class="preview"><video id="local-video" class="preview-video" autoplay muted playsinline></video></div>
        <div class="lobby-actions">
          <button class="btn btn--primary" onclick="handleCreateRoom()" ${!state.signalingConnected ? 'disabled' : ''}>${state.waitingForPeer ? 'Waiting...' : 'Start Session'}</button>
          ${
            state.joinLink && state.waitingForPeer
              ? `<div class="invite">
            <input id="invite-link" class="invite-link" type="text" readonly onclick="this.select()">
            <button class="btn" onclick="copyJoinLink()">Copy invite link</button>
          </div>`
              : ''
          }
          <form onsubmit="handleJoinRoom(event)" class="join-form">
            <input id="room-input" type="text" placeholder="Paste invite link" autocomplete="off" ${!state.signalingConnected ? 'disabled' : ''}>
            <button type="submit" class="btn" ${!state.signalingConnected ? 'disabled' : ''}>Join</button>
          </form>
        </div>
        <div class="media-controls">
          <button class="media-btn ${state.cameraOn ? '' : 'media-btn--off'}" onclick="toggleCamera()">${state.cameraOn ? ICONS.cameraOn : ICONS.cameraOff}</button>
          <button class="media-btn ${state.muted ? 'media-btn--off' : ''}" onclick="toggleMute()">${state.muted ? ICONS.micOff : ICONS.micOn}</button>
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
          <video id="remote-video" class="remote-video" autoplay playsinline></video>
          <video id="local-video" class="pip-video" autoplay muted playsinline></video>
        </div>
        <div class="call-info"><span>Room <strong id="room-ref"></strong></span>${cipherPill()}<span id="timer">${fmtTime(state.elapsed)}</span></div>
        ${
          state.sas && !pillIsRed()
            ? `<div class="sas">
          <span class="sas-emoji">${state.sas.emoji.join(' ')}</span>
          <strong class="sas-digits" id="sas-digits"></strong>
          <span class="sas-hint">Compare with your partner on camera — same emoji, same digits.</span>
          <button class="sas-mismatch" onclick="handleSasMismatch()">Doesn't match</button>
        </div>`
            : ''
        }
        <div id="quantum-panel" class="quantum-panel">
          ${
            state.bb84Active
              ? `
            <div class="qd-header">
              <span class="qd-title">BB84 Quantum Channel</span>
              <span class="qd-badge qd-status--${qberStatus()}">${qberStatusLabel()}</span>
            </div>
            ${
              state.pipeline.length
                ? `<div class="qd-pipeline">${state.pipeline
                    .map(
                      (st) => `
              <div class="qd-step qd-step--${st.status}">
                <span class="qd-step-label">${st.label}</span>
                <span class="qd-step-detail">${st.detail || ''}</span>
              </div>`,
                    )
                    .join('')}</div>`
                : ''
            }
            <div class="qd-metrics">
              <div class="qd-metric"><span class="qd-metric-value ${state.qber !== null && state.qber > QBER_THRESHOLD ? 'qd-metric--danger' : state.qber !== null && state.qber > QBER_WARNING ? 'qd-metric--warning' : ''}">${state.qber !== null ? (state.qber * 100).toFixed(1) + '%' : '--'}</span><span class="qd-metric-label">QBER</span></div>
              <div class="qd-metric"><span class="qd-metric-value">${state.qberHistory.length}</span><span class="qd-metric-label">Rounds</span></div>
              <div class="qd-metric"><span class="qd-metric-value">${state.keyBudget}</span><span class="qd-metric-label">Key bits</span></div>
            </div>
            <canvas id="qd-chart" class="qd-chart"></canvas>
            ${state.isInitiator ? `<button class="qd-eve-btn ${state.eavesdropper ? 'qd-eve-btn--active' : ''}" onclick="toggleEavesdropper()">${state.eavesdropper ? 'Eavesdropper active — click to remove' : 'Simulate eavesdropper'}</button>` : ''}`
              : '<div class="qd-inactive">Establishing quantum channel...</div>'
          }
        </div>
        <div class="toolbar">
          <button class="media-btn ${state.cameraOn ? '' : 'media-btn--off'}" onclick="toggleCamera()">${state.cameraOn ? ICONS.cameraOn : ICONS.cameraOff}</button>
          <button class="media-btn ${state.muted ? 'media-btn--off' : ''}" onclick="toggleMute()">${state.muted ? ICONS.micOff : ICONS.micOn}</button>
          <button class="btn btn--danger" onclick="handleLeave()">${ICONS.phoneOff} Leave</button>
        </div>
      </div>
      <div id="toast" class="toast"></div>`;
    const roomRef = document.getElementById('room-ref');
    if (roomRef) roomRef.textContent = state.roomId ? `${state.roomId.slice(0, 4)}\u2026` : '';
    const sasDigits = document.getElementById('sas-digits');
    if (sasDigits && state.sas) sasDigits.textContent = state.sas.digits;
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
  pendingRoomToken = parseRoomToken(window.location.hash);
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
window.handleSasMismatch = handleSasMismatch;
