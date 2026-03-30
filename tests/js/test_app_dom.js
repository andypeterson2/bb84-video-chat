/**
 * DOM rendering tests for app.js.
 *
 * Loads app.js into a jsdom environment and verifies that render()
 * produces the correct DOM structure for each UI state.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// app.js lives in the parent website repo (public/video-chat/js/app.js).
// When running in CI on the standalone QVC repo, it won't exist — skip tests.
import { existsSync } from 'node:fs';
const APP_JS_PATH = resolve(__dirname, '../../../../public/video-chat/js/app.js');
const APP_JS_EXISTS = existsSync(APP_JS_PATH);

// Stub globals that app.js expects
function setupGlobals() {
  // requestAnimationFrame polyfill for jsdom
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));

  // Socket.IO stub
  globalThis.io = () => ({
    on: () => {},
    emit: () => {},
    disconnect: () => {},
    connected: false,
  });

  // navigator.mediaDevices stub
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: {
      getUserMedia: () =>
        Promise.resolve({
          getTracks: () => [],
          getVideoTracks: () => [],
          getAudioTracks: () => [],
        }),
      enumerateDevices: () => Promise.resolve([]),
    },
    configurable: true,
  });

  // RTCPeerConnection stub
  globalThis.RTCPeerConnection = class {
    constructor() {
      this.onicecandidate = null;
      this.oniceconnectionstatechange = null;
      this.ontrack = null;
      this.ondatachannel = null;
      this.iceConnectionState = 'new';
    }
    addTrack() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
    createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    createDataChannel() {
      return { onopen: null, onmessage: null, onclose: null, close: () => {} };
    }
    close() {}
  };

  // Canvas context stub
  const canvasCtxStub = {
    clearRect: () => {},
    fillRect: () => {},
    fillText: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    stroke: () => {},
    strokeRect: () => {},
    fill: () => {},
    setLineDash: () => {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };
  HTMLCanvasElement.prototype.getContext = function () { return canvasCtxStub; };

  // captureStream stub (for test media sources)
  HTMLCanvasElement.prototype.captureStream = function () {
    return new MediaStream();
  };

  // MediaStream stub
  if (!globalThis.MediaStream) {
    globalThis.MediaStream = class MediaStream {
      #tracks;
      constructor(tracks = []) { this.#tracks = [...tracks]; }
      getTracks() { return this.#tracks; }
      getVideoTracks() { return this.#tracks.filter(t => t.kind === 'video'); }
      getAudioTracks() { return this.#tracks.filter(t => t.kind === 'audio'); }
    };
  }

  // AudioContext stub (for test audio sources)
  const oscStub = { type: '', frequency: { value: 0 }, connect: () => {}, start: () => {}, stop: () => {} };
  const gainStub = { gain: { value: 0 }, connect: () => {} };
  const destStub = { stream: new MediaStream() };
  globalThis.AudioContext = class AudioContext {
    createOscillator() { return { ...oscStub }; }
    createGain() { return { ...gainStub }; }
    createMediaStreamDestination() { return { ...destStub }; }
    close() { return Promise.resolve(); }
  };
  globalThis.webkitAudioContext = globalThis.AudioContext;

  // HTMLMediaElement.setSinkId stub
  HTMLMediaElement.prototype.setSinkId = function () { return Promise.resolve(); };

  // localStorage stub
  const store = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    configurable: true,
  });

  // requestAnimationFrame stub
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

/**
 * Load app.js into the current jsdom context.
 * Uses vm.runInThisContext so top-level var/function declarations
 * become properties of the global object (window).
 */
function loadApp() {
  let code = readFileSync(APP_JS_PATH, 'utf-8');
  // Convert top-level const/let to var so they become function-scoped
  // and accessible via our return object.
  // Only match lines at column 0 (top-level declarations).
  code = code.replace(/^(const|let) /gm, 'var ');
  // Execute inside a function that has access to window/document via jsdom.
  // Use `with(window)` is not available in strict mode, so instead we
  // execute the code as a script via the Function constructor which
  // inherits the jsdom global scope.
  const script = new Function(code + `
    return {
      state, render, toggleCamera, toggleMute, createRoom,
      leaveSession, showToast, dismissToast, formatTime, handleJoin,
      handleMediaSourceChange, handleAudioOutputChange, applyAudioOutput,
      getLocalMedia, stopLocalMedia, cleanupTestMedia, createTestStream,
      enumerateAudioOutputDevices,
    };
  `);
  return script();
}

const describeIfAppExists = APP_JS_EXISTS ? describe : describe.skip;

describeIfAppExists('App DOM Rendering', () => {
  let app;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="app" class="main-screen"></div>';
    document.documentElement.setAttribute('data-theme', 'dark');
    setupGlobals();
    app = loadApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('Lobby view (not in call)', () => {
    test('renders lobby when not connected', () => {
      app.state.connected = false;
      app.state.roomId = '';
      app.render();

      expect(document.querySelector('.lobby')).not.toBeNull();
      expect(document.querySelector('.lobby-title').textContent).toBe('QKD Video Chat');
    });

    test('join button is disabled when not connected', () => {
      app.state.connected = false;
      app.render();

      const joinBtn = document.querySelector('.lobby-btn[type="submit"]');
      expect(joinBtn.disabled).toBe(true);
    });

    test('join button is enabled when connected', () => {
      app.state.connected = true;
      app.render();

      const joinBtn = document.querySelector('.lobby-btn[type="submit"]');
      expect(joinBtn.disabled).toBe(false);
    });

    test('no separate start session button (empty join creates room)', () => {
      app.state.connected = true;
      app.render();

      const startBtn = document.querySelector('.lobby-start-btn');
      expect(startBtn).toBeNull();
    });

    test('room ID input accepts numeric only', () => {
      app.state.connected = true;
      app.render();

      const input = document.getElementById('join-room-id');
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.getAttribute('maxlength')).toBe('5');
    });

    test('shows waiting spinner when waitingForPeer', () => {
      app.state.connected = true;
      app.state.waitingForPeer = true;
      app.state.roomId = 'ABC12';
      app.render();

      const waiting = document.querySelector('.lobby-waiting');
      expect(waiting).not.toBeNull();
      expect(waiting.textContent).toContain('Waiting for peer');
      expect(waiting.textContent).toContain('ABC12');
    });

    test('shows self-video element', () => {
      app.state.connected = true;
      app.render();

      const selfVideo = document.getElementById('self-video');
      expect(selfVideo).not.toBeNull();
      expect(selfVideo.tagName).toBe('VIDEO');
    });

    test('shows noise canvas when camera is off', () => {
      app.state.connected = true;
      app.state.cameraOn = false;
      app.render();

      const noise = document.getElementById('noise-canvas');
      expect(noise).not.toBeNull();
      expect(document.querySelector('.noise-label').textContent).toBe('Camera Off');
    });

    test('no redundant connection status indicator in lobby', () => {
      app.state.connected = true;
      app.render();

      // Connection status is handled by the navbar, not the lobby
      expect(document.querySelector('.conn-dot')).toBeNull();
      expect(document.querySelector('.conn-state')).toBeNull();
    });

    test('media toggle buttons render correctly', () => {
      app.state.connected = true;
      app.state.cameraOn = true;
      app.state.muted = false;
      app.render();

      const mediaBtns = document.querySelectorAll('.lobby-media-btn');
      expect(mediaBtns.length).toBe(2);
      // Neither should have the --off modifier
      expect(mediaBtns[0].classList.contains('lobby-media-btn--off')).toBe(false);
      expect(mediaBtns[1].classList.contains('lobby-media-btn--off')).toBe(false);
    });

    test('camera off button has --off class', () => {
      app.state.connected = true;
      app.state.cameraOn = false;
      app.render();

      const cameraBtns = document.querySelectorAll('.lobby-media-btn');
      // First button is camera
      expect(cameraBtns[0].classList.contains('lobby-media-btn--off')).toBe(true);
    });

    test('muted button has --off class', () => {
      app.state.connected = true;
      app.state.muted = true;
      app.render();

      const mediaBtns = document.querySelectorAll('.lobby-media-btn');
      // Second button is mic
      expect(mediaBtns[1].classList.contains('lobby-media-btn--off')).toBe(true);
    });
  });

  describe('In-call view', () => {
    beforeEach(() => {
      app.state.connected = true;
      app.state.roomId = 'XYZ99';
      app.state.waitingForPeer = false;
      app.state.peerConnected = true;
    });

    test('renders incall view when in a room', () => {
      app.render();

      expect(document.querySelector('.incall')).not.toBeNull();
      expect(document.querySelector('.lobby')).toBeNull();
    });

    test('shows room code', () => {
      app.render();

      const roomLabel = document.querySelector('.incall-room');
      expect(roomLabel.textContent).toContain('XYZ99');
    });

    test('shows peer-video element', () => {
      app.render();

      const peerVideo = document.getElementById('peer-video');
      expect(peerVideo).not.toBeNull();
      expect(peerVideo.tagName).toBe('VIDEO');
    });

    test('shows self-video PIP element', () => {
      app.render();

      const selfVideo = document.getElementById('self-video');
      expect(selfVideo).not.toBeNull();
      expect(selfVideo.closest('.incall-pip')).not.toBeNull();
    });

    test('shows elapsed timer', () => {
      app.state.elapsed = 65;
      app.render();

      const timer = document.getElementById('elapsed-timer');
      expect(timer.textContent).toBe('01:05');
    });

    test('shows toolbar with camera, mic, and leave buttons', () => {
      app.render();

      const toolbar = document.querySelector('.incall-toolbar');
      expect(toolbar).not.toBeNull();

      const toolBtns = document.querySelectorAll('.incall-tool-btn');
      expect(toolBtns.length).toBe(2); // camera + mic

      const leaveBtn = document.querySelector('.incall-leave-btn');
      expect(leaveBtn).not.toBeNull();
    });

    test('camera off shows --off class on toolbar button', () => {
      app.state.cameraOn = false;
      app.render();

      const toolBtns = document.querySelectorAll('.incall-tool-btn');
      expect(toolBtns[0].classList.contains('incall-tool-btn--off')).toBe(true);
    });

    test('muted shows --off class on toolbar button', () => {
      app.state.muted = true;
      app.render();

      const toolBtns = document.querySelectorAll('.incall-tool-btn');
      expect(toolBtns[1].classList.contains('incall-tool-btn--off')).toBe(true);
    });

    test('shows quantum panel', () => {
      app.render();

      const panel = document.getElementById('quantum-panel');
      expect(panel).not.toBeNull();
    });

    test('quantum panel shows pending message when BB84 not active', () => {
      app.state.bb84Active = false;
      app.render();

      const panel = document.getElementById('quantum-panel');
      expect(panel.textContent).toContain('Encryption pending');
    });

    test('quantum panel shows QBER when BB84 is active', () => {
      app.state.bb84Active = true;
      app.state.qber = 0.035;
      app.state.qberEvent = 'normal';
      app.state.qberHistory = [{ qber: 0.035, time: Date.now() }];
      app.render();

      const panel = document.getElementById('quantum-panel');
      expect(panel.textContent).toContain('3.50%');
      expect(panel.textContent).toContain('QBER');
      expect(panel.textContent).toContain('Secure');
    });
  });

  describe('State transitions', () => {
    test('lobby → waiting → in-call → lobby lifecycle', () => {
      // Start in lobby
      app.state.connected = true;
      app.render();
      expect(document.querySelector('.lobby')).not.toBeNull();
      expect(document.querySelector('.incall')).toBeNull();

      // Create room → waiting
      app.state.waitingForPeer = true;
      app.state.roomId = 'ABC12';
      app.render();
      expect(document.querySelector('.lobby')).not.toBeNull();
      expect(document.querySelector('.lobby-waiting')).not.toBeNull();

      // Peer joins → in-call
      app.state.waitingForPeer = false;
      app.state.peerConnected = true;
      app.render();
      expect(document.querySelector('.incall')).not.toBeNull();
      expect(document.querySelector('.lobby')).toBeNull();

      // Leave → lobby
      app.state.roomId = '';
      app.state.peerConnected = false;
      app.render();
      expect(document.querySelector('.lobby')).not.toBeNull();
      expect(document.querySelector('.incall')).toBeNull();
    });
  });

  describe('Utility functions', () => {
    test('formatTime formats seconds correctly', () => {
      expect(app.formatTime(0)).toBe('00:00');
      expect(app.formatTime(59)).toBe('00:59');
      expect(app.formatTime(60)).toBe('01:00');
      expect(app.formatTime(3661)).toBe('61:01');
    });
  });

  describe('Media source selection', () => {
    test('lobby renders source dropdown with three options', () => {
      app.state.connected = true;
      app.render();

      const select = document.getElementById('media-source-select');
      expect(select).not.toBeNull();
      expect(select.tagName).toBe('SELECT');

      const options = select.querySelectorAll('option');
      expect(options.length).toBe(3);
      expect(options[0].value).toBe('camera');
      expect(options[1].value).toBe('test-a');
      expect(options[2].value).toBe('test-b');
    });

    test('source dropdown reflects current mediaSource state', () => {
      app.state.connected = true;
      app.state.mediaSource = 'test-b';
      app.render();

      const select = document.getElementById('media-source-select');
      expect(select.value).toBe('test-b');
    });

    test('handleMediaSourceChange updates state', async () => {
      app.state.connected = true;
      app.state.mediaSource = 'camera';
      app.handleMediaSourceChange('test-a');
      expect(app.state.mediaSource).toBe('test-a');
    });

    test('handleMediaSourceChange is a no-op for same value', () => {
      app.state.mediaSource = 'camera';
      app.handleMediaSourceChange('camera');
      // Should not throw or change anything
      expect(app.state.mediaSource).toBe('camera');
    });

    test('createTestStream returns a MediaStream', () => {
      const stream = app.createTestStream('test-a');
      expect(stream).toBeInstanceOf(MediaStream);
    });

    test('cleanupTestMedia does not throw when no test media active', () => {
      expect(() => app.cleanupTestMedia()).not.toThrow();
    });

    test('stopLocalMedia does not throw when no stream active', () => {
      expect(() => app.stopLocalMedia()).not.toThrow();
    });
  });

  describe('Audio output device selection', () => {
    test('speaker dropdown hidden when sinkIdSupported is false', () => {
      app.state.connected = true;
      app.state.sinkIdSupported = false;
      app.render();

      expect(document.getElementById('audio-output-select')).toBeNull();
    });

    test('speaker dropdown hidden when no output devices', () => {
      app.state.connected = true;
      app.state.sinkIdSupported = true;
      app.state.audioOutputDevices = [];
      app.render();

      expect(document.getElementById('audio-output-select')).toBeNull();
    });

    test('speaker dropdown shown when supported and devices available', () => {
      app.state.connected = true;
      app.state.sinkIdSupported = true;
      app.state.audioOutputDevices = [
        { deviceId: 'default', kind: 'audiooutput', label: 'Default Speaker' },
        { deviceId: 'abc123', kind: 'audiooutput', label: 'Headphones' },
      ];
      app.render();

      const select = document.getElementById('audio-output-select');
      expect(select).not.toBeNull();
      const options = select.querySelectorAll('option');
      expect(options.length).toBe(2);
      expect(options[0].textContent).toBe('Default Speaker');
      expect(options[1].textContent).toBe('Headphones');
    });

    test('handleAudioOutputChange updates selectedAudioOutput state', () => {
      app.state.sinkIdSupported = true;
      app.handleAudioOutputChange('abc123');
      expect(app.state.selectedAudioOutput).toBe('abc123');
    });

    test('in-call view shows output select when >1 device and supported', () => {
      app.state.connected = true;
      app.state.roomId = 'XYZ99';
      app.state.waitingForPeer = false;
      app.state.peerConnected = true;
      app.state.sinkIdSupported = true;
      app.state.audioOutputDevices = [
        { deviceId: 'default', kind: 'audiooutput', label: 'Default Speaker' },
        { deviceId: 'abc123', kind: 'audiooutput', label: 'Headphones' },
      ];
      app.render();

      const select = document.querySelector('.incall-output-select');
      expect(select).not.toBeNull();
    });

    test('in-call view hides output select when only 1 device', () => {
      app.state.connected = true;
      app.state.roomId = 'XYZ99';
      app.state.waitingForPeer = false;
      app.state.peerConnected = true;
      app.state.sinkIdSupported = true;
      app.state.audioOutputDevices = [
        { deviceId: 'default', kind: 'audiooutput', label: 'Default Speaker' },
      ];
      app.render();

      const select = document.querySelector('.incall-output-select');
      expect(select).toBeNull();
    });

    test('applyAudioOutput does not throw when no peer-video element', () => {
      app.state.sinkIdSupported = true;
      expect(() => app.applyAudioOutput()).not.toThrow();
    });
  });

  describe('Toast notifications', () => {
    test('showToast makes toast visible', () => {
      app.render();
      app.showToast('Test message');

      const toast = document.getElementById('toast');
      expect(toast.classList.contains('toast--visible')).toBe(true);
      expect(document.getElementById('toast-msg').textContent).toBe('Test message');
    });

    test('dismissToast hides toast', () => {
      app.render();
      app.showToast('Test');
      app.dismissToast();

      const toast = document.getElementById('toast');
      expect(toast.classList.contains('toast--hidden')).toBe(true);
    });
  });
});
