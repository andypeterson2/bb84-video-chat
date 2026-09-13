/**
 * Render tests for the page bootstrap script, loaded via the Function
 * constructor. Pins the lobby (invite link, join-input preservation), the
 * cipher pill for every worker state, and the room-token parser both entry
 * points share.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS_PATH = resolve(__dirname, '../../website/client/static/app.js');

function setupGlobals() {
  // Only touched at connect/call time, but they must exist at load.
  globalThis.io = () => ({ on: () => {}, emit: () => {}, disconnect: () => {} });
  const ctxStub = new Proxy({}, { get: (t, prop) => (prop === 'canvas' ? {} : () => ctxStub) });
  HTMLCanvasElement.prototype.getContext = function () {
    return ctxStub;
  };
}

/**
 * Load the bootstrap into the jsdom context. Top-level const/let become var so
 * the trailing return can hand the internals back to the tests.
 */
function loadApp() {
  let code = readFileSync(APP_JS_PATH, 'utf-8');
  code = code.replace(/^(const|let) /gm, 'var ');
  const script = new Function(
    code +
      `
    return {
      state, render, parseRoomToken, resetSession,
      setPendingRoomToken: (v) => { pendingRoomToken = v; },
      getPendingRoomToken: () => pendingRoomToken,
    };
  `,
  );
  return script();
}

let app;

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  setupGlobals();
  app = loadApp();
});

describe('lobby rendering', () => {
  test('renders the lobby with a join form when not in a call', () => {
    app.render();
    expect(document.querySelector('.lobby')).not.toBeNull();
    expect(document.querySelector('h1').textContent).toBe('QKD Video Chat');
    expect(document.getElementById('room-input')).not.toBeNull();
  });

  test('invite link and copy control appear while waiting for a peer', () => {
    app.state.joinLink = 'https://example.test/#room=abcdefghijklmnop';
    app.state.waitingForPeer = true;
    app.render();
    const invite = document.getElementById('invite-link');
    expect(invite).not.toBeNull();
    // Set via the value sink, never innerHTML — the link is a credential.
    expect(invite.value).toBe(app.state.joinLink);
    expect(document.querySelector('.invite .btn')).not.toBeNull();
  });

  test('a typed room value survives a re-render', () => {
    app.render();
    document.getElementById('room-input').value = 'half-typed-token';
    app.render(); // toast/status updates re-render while the user types
    expect(document.getElementById('room-input').value).toBe('half-typed-token');
  });

  test('a pending invite token prefills the input exactly once', () => {
    app.setPendingRoomToken('abcdefghijklmnop');
    app.render();
    expect(document.getElementById('room-input').value).toBe('abcdefghijklmnop');
    expect(app.getPendingRoomToken()).toBe('');
  });

  test('a pending invite token never overwrites what the user typed', () => {
    app.render();
    document.getElementById('room-input').value = 'user-was-here';
    app.setPendingRoomToken('abcdefghijklmnop');
    app.render();
    expect(document.getElementById('room-input').value).toBe('user-was-here');
    // Kept for the next empty render rather than silently dropped.
    expect(app.getPendingRoomToken()).toBe('abcdefghijklmnop');
  });
});

describe('cipher pill', () => {
  const pill = (cipherState) => {
    app.state.peerConnected = true;
    app.state.cipherState = cipherState;
    if (cipherState === 'encrypted') app.state.keyIndex = 2;
    app.render();
    return document.querySelector('.cipher-pill');
  };

  test('establishing state renders the neutral pill', () => {
    const el = pill('establishing');
    expect(el.className).toContain('cipher-pill--establishing');
    expect(el.textContent).toContain('Establishing');
  });

  test('encrypted state shows AES-GCM and the key index', () => {
    const el = pill('encrypted');
    expect(el.className).toContain('cipher-pill--encrypted');
    expect(el.textContent).toContain('AES-GCM');
    expect(el.textContent).toContain('#2');
  });

  test('unencrypted state is the red media-blocked pill', () => {
    const el = pill('unencrypted');
    expect(el.className).toContain('cipher-pill--unencrypted');
    expect(el.textContent).toContain('Not encrypted');
  });

  test('compromised state is red with its own class and names the integrity loss', () => {
    const el = pill('compromised');
    expect(el.className).toContain('cipher-pill--compromised');
    expect(el.textContent).toContain('integrity lost');
  });

  test('unsupported browser state is red with its own class and blames the browser', () => {
    const el = pill('unsupported');
    expect(el.className).toContain('cipher-pill--unsupported');
    expect(el.textContent).toContain('unsupported');
  });

  test('the SAS strip renders while the pill is not red', () => {
    app.state.peerConnected = true;
    app.state.cipherState = 'encrypted';
    app.state.sas = { digits: '123456', emoji: ['🐙', '🦊', '🐢', '🦉'] };
    app.render();
    expect(document.querySelector('.sas')).not.toBeNull();
    expect(document.getElementById('sas-digits').textContent).toBe('123456');
  });

  test('the SAS strip stays visible while the pill is red (the reject control must remain)', () => {
    // A red pill is exactly when a user might want to reject the channel, so
    // the compare strip — and its "Doesn't match" control — stays on screen.
    app.state.peerConnected = true;
    app.state.sasVerified = false;
    app.state.sas = { digits: '123456', emoji: ['🐙', '🦊', '🐢', '🦉'] };
    for (const red of ['unencrypted', 'compromised', 'unsupported']) {
      app.state.cipherState = red;
      app.render();
      expect(document.querySelector('.sas')).not.toBeNull();
      expect(document.querySelector('.sas-mismatch')).not.toBeNull();
    }
  });

  test('the SAS shows a Matches/verify action, and collapses to verified once confirmed', () => {
    app.state.peerConnected = true;
    app.state.cipherState = 'encrypted';
    app.state.sasVerified = false;
    app.state.sas = { digits: '123456', emoji: ['🐙', '🦊', '🐢', '🦉'] };
    app.render();
    expect(document.querySelector('.btn-verify')).not.toBeNull();

    app.state.sasVerified = true;
    app.render();
    expect(document.querySelector('.sas--verified')).not.toBeNull();
    expect(document.querySelector('.btn-verify')).toBeNull();
    expect(document.querySelector('.verified-badge')).not.toBeNull();
  });

  test('the reservoir dashboard shows QBER, keys, rotations and pool — no AES-GCM tile', () => {
    app.state.peerConnected = true;
    app.state.bb84Active = true;
    app.state.dashboardExpanded = true;
    app.render();
    const labels = [...document.querySelectorAll('.qd-metric-label')].map((n) => n.textContent);
    expect(labels).toEqual(['QBER', 'Keys', 'Rotations', 'Pool']);
  });

  test('the dashboard is collapsed by default (video-first) and expands on toggle', () => {
    app.state.peerConnected = true;
    app.state.bb84Active = true;
    app.state.dashboardExpanded = false;
    app.render();
    expect(document.querySelector('.qd-toggle')).not.toBeNull(); // compact summary row
    expect(document.querySelector('.qd-body')).toBeNull(); // telemetry hidden
    expect(document.querySelector('.qd-metric-label')).toBeNull();

    app.state.dashboardExpanded = true;
    app.render();
    expect(document.querySelector('.qd-body')).not.toBeNull();
  });

  test('the diagnostics line surfaces the throughput limiter and crypto latency', () => {
    app.state.peerConnected = true;
    app.state.bb84Active = true;
    app.state.dashboardExpanded = true;
    app.state.quality = { tier: 'Full HD', bandwidthKbps: 5200, rttMs: 42, limitedBy: 'cpu' };
    app.state.cryptoMetrics = { encryptLatencyUs: 47, decryptLatencyUs: 39 };
    app.render();
    const diag = document.querySelector('.qd-diag');
    expect(diag).not.toBeNull();
    expect(diag.textContent).toContain('Full HD');
    expect(diag.textContent).toContain('limited by cpu');
    expect(diag.textContent).toContain('47/39');
  });

  test('the diagnostics line is absent before any telemetry arrives', () => {
    app.state.peerConnected = true;
    app.state.bb84Active = true;
    app.state.dashboardExpanded = true;
    app.state.quality = null;
    app.state.cryptoMetrics = null;
    app.render();
    expect(document.querySelector('.qd-diag')).toBeNull();
  });

  test('the mode badge reads SIMULATED until an optical backend negotiates', () => {
    app.state.peerConnected = true;
    app.state.bb84Active = true;
    app.render();
    expect(document.querySelector('.qd-mode').textContent).toBe('SIMULATED');
    app.state.mode = 'optical';
    app.render();
    expect(document.querySelector('.qd-mode').textContent).toBe('OPTICAL');
  });

  test('the distillation gauge fills toward the mint budget', () => {
    app.state.peerConnected = true;
    app.state.bb84Active = true;
    app.state.dashboardExpanded = true;
    app.state.reservoirBits = 110;
    app.state.mintBudget = 220;
    app.render();
    const fill = document.querySelector('.qd-distill-fill');
    expect(fill.style.width).toBe('50%');
  });
});

describe('optical bench settings', () => {
  test('the toggle is off by default and shows no fields', () => {
    app.render();
    const toggle = document.querySelector('.optical-toggle input');
    expect(toggle).not.toBeNull();
    expect(toggle.checked).toBe(false);
    expect(document.querySelector('.optical-fields')).toBeNull();
  });

  test('enabling reveals the url and token fields', () => {
    app.state.optical = { enabled: true, url: 'ws://127.0.0.1:8781', token: '' };
    app.render();
    expect(document.querySelector('.optical-fields')).not.toBeNull();
    expect(document.getElementById('optical-url').value).toBe('ws://127.0.0.1:8781');
    expect(document.getElementById('optical-token')).not.toBeNull();
  });

  test('the token is restored via the value sink, not the HTML string', () => {
    app.state.optical = { enabled: true, url: 'ws://x', token: 'secret-token' };
    app.render();
    // The secret must not appear in the rendered markup...
    expect(document.getElementById('app').innerHTML).not.toContain('secret-token');
    // ...but is present in the field's live value.
    expect(document.getElementById('optical-token').value).toBe('secret-token');
  });
});

describe('parseRoomToken', () => {
  test('extracts the token from a full invite link', () => {
    expect(app.parseRoomToken('https://example.test/chat#room=abcDEF123456789_-x')).toBe(
      'abcDEF123456789_-x',
    );
  });

  test('accepts a bare token', () => {
    expect(app.parseRoomToken('  abcdefghijklmnop  ')).toBe('abcdefghijklmnop');
  });

  test('trims trailing junk a chat client glued on', () => {
    expect(app.parseRoomToken('#room=abcdefghijklmnop%20(click%20me!)')).toBe('abcdefghijklmnop');
    expect(app.parseRoomToken('abcdefghijklmnop.')).toBe('abcdefghijklmnop');
  });

  test('rejects short or invalid candidates', () => {
    expect(app.parseRoomToken('tooshort')).toBe('');
    expect(app.parseRoomToken('!!!not a token!!!')).toBe('');
    expect(app.parseRoomToken('')).toBe('');
  });

  test('malformed percent-encoding yields empty, not an exception', () => {
    expect(app.parseRoomToken('#room=%E0%A4%A')).toBe('');
  });
});
