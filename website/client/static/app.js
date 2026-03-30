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
  encryptionEnabled: false,
  errorMessage: '',
};

let elapsedInterval = null;
let socket = null;
let webrtcManager = null;
let metricsCollector = null;
let localStream = null;

/* ── Icons ──────────────────────────────────────────────────────── */
const ICONS = {
  cameraOn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="14" height="14"/><path d="M16 10l6-3v10l-6-3"/></svg>',
  cameraOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="5" width="14" height="14"/><path d="M16 10l6-3v10l-6-3"/><line x1="2" y1="3" x2="22" y2="21" stroke-width="2"/></svg>',
  micOn: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="2" width="8" height="12"/><path d="M4 10v1a8 8 0 0016 0v-1"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
  micOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="2" width="8" height="12"/><path d="M4 10v1a8 8 0 0016 0v-1"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="2" y1="3" x2="22" y2="21" stroke-width="2"/></svg>',
  phoneOff: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 004.05.7 2 2 0 011.98 2v3.5a2 2 0 01-2.18 2A19.79 19.79 0 013.07 4.18 2 2 0 015.07 2H8.6a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L9.58 9.91"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="2"/></svg>',
};

/* ── Signaling ──────────────────────────────────────────────────── */

function connectToSignaling(url) {
  if (socket) socket.disconnect();
  socket = io(url, { transports: ['websocket'] });

  socket.on('connect', () => { state.signalingConnected = true; render(); });
  socket.on('disconnect', () => { state.signalingConnected = false; state.peerConnected = false; render(); });
  socket.on('welcome', () => render());

  import('./js/webrtc.js').then(({ WebRTCManager }) => {
    webrtcManager = new WebRTCManager(socket, { enableEncryption: state.encryptionEnabled });

    webrtcManager.on('room-created', (d) => { state.roomId = d.room_id; state.waitingForPeer = true; render(); });
    webrtcManager.on('room-joined', async () => {
      state.waitingForPeer = false;
      if (!localStream) { localStream = await webrtcManager.getLocalMedia(); showLocalVideo(localStream); }
    });
    webrtcManager.on('remote-stream', (d) => { state.peerConnected = true; state.elapsed = 0; startTimer(); showRemoteVideo(d.stream); render(); });
    webrtcManager.on('data-channel-open', () => { state.bb84Active = true; render(); });
    webrtcManager.on('data-channel-message', (d) => handleBB84Message(d));
    webrtcManager.on('peer-disconnected', () => { state.peerConnected = false; state.roomId = ''; state.bb84Active = false; stopTimer(); clearRemoteVideo(); render(); showToast('Peer disconnected.'); });
    webrtcManager.on('error', (d) => showToast(d.message || 'Error'));
    webrtcManager.on('state-change', (d) => { state.peerConnected = (d.state === 'connected'); render(); });
  });

  import('./js/metrics.js').then(({ MetricsCollector }) => {
    metricsCollector = new MetricsCollector();
    metricsCollector.subscribe('qber-exceeded', () => showToast('QBER exceeded — possible eavesdropper!'));
    metricsCollector.subscribe('key-budget-low', () => { if (webrtcManager) startBB84Round(); });
  });
}

/* ── BB84 ───────────────────────────────────────────────────────── */
function handleBB84Message(data) { console.log('BB84:', data); }
function startBB84Round() { console.log('BB84 round...'); }

/* ── Video ──────────────────────────────────────────────────────── */
function showLocalVideo(s) { const v = document.getElementById('local-video'); if (v) { v.srcObject = s; v.play().catch(() => {}); } }
function showRemoteVideo(s) { const v = document.getElementById('remote-video'); if (v) { v.srcObject = s; v.play().catch(() => {}); } }
function clearRemoteVideo() { const v = document.getElementById('remote-video'); if (v) v.srcObject = null; }

/* ── Actions ────────────────────────────────────────────────────── */
function toggleCamera() { state.cameraOn = !state.cameraOn; if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = state.cameraOn; }); render(); }
function toggleMute() { state.muted = !state.muted; if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; }); render(); }

function handleCreateRoom() {
  if (!webrtcManager) return;
  webrtcManager.getLocalMedia().then(s => { localStream = s; showLocalVideo(s); webrtcManager.createRoom(); });
}

function handleJoinRoom(e) {
  e.preventDefault();
  const input = document.getElementById('room-input');
  const id = input ? input.value.trim().toUpperCase() : '';
  if (!id) { showToast('Enter a room ID.'); return; }
  if (!webrtcManager) return;
  webrtcManager.getLocalMedia().then(s => { localStream = s; showLocalVideo(s); webrtcManager.joinRoom(id); });
}

function handleLeave() {
  if (webrtcManager) webrtcManager.leave();
  state.peerConnected = false; state.roomId = ''; state.waitingForPeer = false; state.bb84Active = false;
  stopTimer(); clearRemoteVideo(); render();
}

/* ── Timer ──────────────────────────────────────────────────────── */
function startTimer() { stopTimer(); state.elapsed = 0; elapsedInterval = setInterval(() => { state.elapsed++; const el = document.getElementById('timer'); if (el) el.textContent = fmtTime(state.elapsed); }, 1000); }
function stopTimer() { if (elapsedInterval) { clearInterval(elapsedInterval); elapsedInterval = null; } }
function fmtTime(s) { return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }

/* ── Toast ──────────────────────────────────────────────────────── */
let toastTimer = null;
function showToast(msg) { const el = document.getElementById('toast'); if (!el) return; el.textContent = msg; el.classList.add('visible'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 5000); }

/* ── Theme ──────────────────────────────────────────────────────── */
function getTheme() { return localStorage.getItem('qvc-theme') || 'dark'; }
function setTheme(t) { localStorage.setItem('qvc-theme', t); document.documentElement.dataset.theme = t; }

/* ── Render ─────────────────────────────────────────────────────── */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const inCall = state.peerConnected;

  if (!inCall) {
    app.innerHTML = `
      <div class="header">
        <h1>QKD Video Chat</h1>
        <div class="status"><span class="dot ${state.signalingConnected ? 'dot--ok' : 'dot--off'}"></span>${state.signalingConnected ? 'Connected' : 'Offline'}</div>
      </div>
      <div class="lobby">
        <div class="preview"><video id="local-video" class="preview-video" autoplay muted playsinline></video></div>
        <div class="lobby-actions">
          <button class="btn btn--primary" onclick="handleCreateRoom()" ${!state.signalingConnected?'disabled':''}>${state.waitingForPeer?'Waiting...':'Start Session'}</button>
          ${state.roomId && state.waitingForPeer ? `<p class="room-code">Room: <strong>${state.roomId}</strong></p>` : ''}
          <form onsubmit="handleJoinRoom(event)" class="join-form">
            <input id="room-input" type="text" placeholder="Room ID" maxlength="5" ${!state.signalingConnected?'disabled':''}>
            <button type="submit" class="btn" ${!state.signalingConnected?'disabled':''}>Join</button>
          </form>
        </div>
        <div class="media-controls">
          <button class="media-btn ${state.cameraOn?'':'media-btn--off'}" onclick="toggleCamera()">${state.cameraOn?ICONS.cameraOn:ICONS.cameraOff}</button>
          <button class="media-btn ${state.muted?'media-btn--off':''}" onclick="toggleMute()">${state.muted?ICONS.micOff:ICONS.micOn}</button>
        </div>
      </div>
      <div id="toast" class="toast"></div>`;
    if (localStream) { const v = document.getElementById('local-video'); if (v) { v.srcObject = localStream; v.play().catch(()=>{}); } }
  } else {
    app.innerHTML = `
      <div class="incall">
        <div class="video-area">
          <video id="remote-video" class="remote-video" autoplay playsinline></video>
          <video id="local-video" class="pip-video" autoplay muted playsinline></video>
        </div>
        <div class="call-info"><span>Room: <strong>${state.roomId}</strong></span><span id="timer">${fmtTime(state.elapsed)}</span></div>
        <div id="quantum-panel" class="quantum-panel">
          ${state.bb84Active ? `
            <div class="qd-header">BB84 Quantum Channel</div>
            <div class="qd-metrics">
              <div class="qd-metric"><span class="qd-value">${state.qber!==null?(state.qber*100).toFixed(1)+'%':'--'}</span><span class="qd-label">QBER</span></div>
              <div class="qd-metric"><span class="qd-value">${state.qberHistory.length}</span><span class="qd-label">Rounds</span></div>
              <div class="qd-metric"><span class="qd-value">${state.keyBudget}</span><span class="qd-label">Key bits</span></div>
            </div>` : '<div class="qd-inactive">Establishing quantum channel...</div>'}
        </div>
        <div class="toolbar">
          <button class="media-btn ${state.cameraOn?'':'media-btn--off'}" onclick="toggleCamera()">${state.cameraOn?ICONS.cameraOn:ICONS.cameraOff}</button>
          <button class="media-btn ${state.muted?'media-btn--off':''}" onclick="toggleMute()">${state.muted?ICONS.micOff:ICONS.micOn}</button>
          <button class="btn btn--danger" onclick="handleLeave()">${ICONS.phoneOff} Leave</button>
        </div>
      </div>
      <div id="toast" class="toast"></div>`;
    if (localStream) { const v = document.getElementById('local-video'); if (v) { v.srcObject = localStream; v.play().catch(()=>{}); } }
  }
}

/* ── Init ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  setTheme(getTheme());
  connectToSignaling(window.QVC_SIGNALING_URL || window.location.origin);
  render();
});

window.handleCreateRoom = handleCreateRoom;
window.handleJoinRoom = handleJoinRoom;
window.handleLeave = handleLeave;
window.toggleCamera = toggleCamera;
window.toggleMute = toggleMute;
