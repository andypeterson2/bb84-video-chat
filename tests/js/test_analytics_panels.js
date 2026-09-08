/**
 * Analytics screen rendering + wiring. The panels render from a telemetry
 * snapshot (real readings only — an honest empty state when there's no call),
 * the window-side series buffers accumulate scalars for the sparklines, and the
 * demo controls post allowlisted commands back over the bus.
 */
import {
  renderPanels,
  createAnalytics,
  SeriesBuffers,
  qberVerdict,
  shortFp,
  eventLabel,
} from '../../website/client/static/js/analytics/analytics.js';

// Canvas stub so the chart/sparkline draws run without a real 2D context.
beforeEach(() => {
  const ctxStub = new Proxy({}, { get: (t, p) => (p === 'canvas' ? {} : () => ctxStub) });
  HTMLCanvasElement.prototype.getContext = () => ctxStub;
  document.body.innerHTML = '<div id="root"></div>';
});

const root = () => document.getElementById('root');

const liveSnap = {
  type: 'telemetry',
  inCall: true,
  bb84Active: true,
  isInitiator: true,
  elapsed: 73,
  mode: 'sim',
  cipherState: 'encrypted',
  keyIndex: 3,
  qber: 0.021,
  qberHistory: [0.01, 0.02, 0.019, 0.021],
  qberThreshold: 0.11,
  qberWarning: 0.08,
  keysMinted: 7,
  rotations: 2,
  poolDepth: 1,
  reservoirBits: 140,
  mintBudget: 256,
  distillFraction: 140 / 256,
  sas: { digits: '481920', emoji: ['🐙', '🦊', '🐢', '🦉'] },
  sasVerified: true,
  fingerprints: { local: 'AA:BB:CC:DD:EE:FF', remote: '11:22:33:44:55:66' },
  quality: {
    bandwidthKbps: 5200,
    rttMs: 42,
    tier: 'Full HD',
    limitedBy: 'cpu',
    actualRes: '1920x1080',
    inRes: '1280x720',
  },
  crypto: { encryptLatencyUs: 47, decryptLatencyUs: 39 },
  eavesdropping: false,
  peerEavesdropping: false,
  events: [
    { t: Date.now() - 5000, kind: 'minted', detail: { keyIndex: 3 } },
    { t: Date.now() - 1000, kind: 'rotated', detail: { keyIndex: 3 } },
  ],
};

describe('renderPanels', () => {
  test('empty state before a call — honest, no fabricated panels', () => {
    renderPanels(root(), { inCall: false }, new SeriesBuffers());
    expect(root().querySelector('.an-empty')).not.toBeNull();
    expect(root().querySelector('.an-grid')).toBeNull();
  });

  test('a live snapshot renders every panel with the real readings', () => {
    renderPanels(root(), liveSnap, new SeriesBuffers());
    const html = root().innerHTML;
    // Reservoir
    expect(html).toContain('Key reservoir');
    expect(html).toContain('SIMULATED');
    // QBER shows the current value + a verdict, plus the strip-chart canvas
    expect(html).toContain('2.1%');
    expect(root().querySelector('[data-chart="qber"]')).not.toBeNull();
    // Security shows the SAS digits + a verified badge
    expect(html).toContain('481920');
    expect(html).toContain('✓ Verified');
    // Media has four sparkline canvases
    expect(root().querySelectorAll('.an-sparkline')).toHaveLength(4);
    // Timeline lists the events by label
    expect(html).toContain('Key minted');
    expect(html).toContain('Key rotated');
    // Controls present, eve enabled for the initiator
    expect(root().querySelector('[data-cmd="force-rotate"]')).not.toBeNull();
    expect(root().querySelector('[data-cmd="toggle-eve"]').disabled).toBe(false);
  });

  test('the eavesdropper control is disabled for a non-initiator', () => {
    renderPanels(root(), { ...liveSnap, isInitiator: false }, new SeriesBuffers());
    expect(root().querySelector('[data-cmd="toggle-eve"]').disabled).toBe(true);
  });

  test('a summary snapshot renders the call summary with the peak QBER', () => {
    renderPanels(root(), { ...liveSnap, inCall: false, summary: true }, new SeriesBuffers());
    expect(root().querySelector('.an-summary')).not.toBeNull();
    expect(root().innerHTML).toContain('Call summary');
    expect(root().innerHTML).toContain('2.1%'); // peak of the qberHistory
    expect(root().querySelector('.an-grid')).toBeNull();
  });
});

describe('SeriesBuffers', () => {
  test('accumulates media scalars, skipping absent ones', () => {
    const b = new SeriesBuffers(120);
    b.push(liveSnap);
    b.push({ quality: { bandwidthKbps: 4800, rttMs: 50 }, crypto: null });
    expect(b.bandwidth).toEqual([5200, 4800]);
    expect(b.rtt).toEqual([42, 50]);
    expect(b.enc).toEqual([47]); // second snapshot had no crypto
  });

  test('is bounded and clears', () => {
    const b = new SeriesBuffers(3);
    for (let i = 0; i < 5; i++) b.push({ quality: { bandwidthKbps: i, rttMs: i } });
    expect(b.bandwidth).toEqual([2, 3, 4]);
    b.clear();
    expect(b.bandwidth).toEqual([]);
  });
});

describe('createAnalytics wiring', () => {
  function harness() {
    const posted = [];
    const store = {
      _d: {},
      getItem(k) {
        return this._d[k] ?? null;
      },
      setItem(k, v) {
        this._d[k] = v;
      },
    };
    const channel = { postMessage: (m) => posted.push(m), onmessage: null };
    const api = createAnalytics({ root: root(), channel, storage: store });
    return { posted, store, channel, api };
  }

  test('renders on a telemetry message and posts a command on a control click', () => {
    const { posted, channel } = harness();
    expect(root().querySelector('.an-empty')).not.toBeNull(); // initial empty

    channel.onmessage({ data: liveSnap });
    expect(root().querySelector('.an-grid')).not.toBeNull();

    root().querySelector('[data-cmd="force-rotate"]').click();
    expect(posted).toContainEqual({ type: 'command', cmd: 'force-rotate' });
  });

  test('a disabled eavesdropper control posts nothing', () => {
    const { posted, channel } = harness();
    channel.onmessage({ data: { ...liveSnap, isInitiator: false } });
    root().querySelector('[data-cmd="toggle-eve"]').click();
    expect(posted).toHaveLength(0);
  });

  test('the density toggle flips the root and persists to storage', () => {
    const { store, channel } = harness();
    channel.onmessage({ data: liveSnap });
    expect(root().dataset.density).toBe('compact');
    root().querySelector('[data-action="density"]').click();
    expect(root().dataset.density).toBe('presentation');
    expect(store.getItem('qvc.analytics.density')).toBe('presentation');
  });

  test('ignores non-telemetry messages', () => {
    const { channel } = harness();
    channel.onmessage({ data: { type: 'command', cmd: 'reset' } });
    expect(root().querySelector('.an-empty')).not.toBeNull(); // still empty
  });
});

describe('pure helpers', () => {
  test('qberVerdict maps against the thresholds', () => {
    expect(qberVerdict(null).label).toBe('Measuring…');
    expect(qberVerdict(0.02, 0.11, 0.08).label).toBe('Clean');
    expect(qberVerdict(0.09, 0.11, 0.08).label).toBe('Noisy');
    expect(qberVerdict(0.2, 0.11, 0.08).label).toBe('Very noisy');
  });

  test('shortFp truncates long fingerprints and passes short/empty through', () => {
    expect(shortFp('AA:BB:CC:DD:EE:FF')).toBe('AA:BB…EE:FF');
    expect(shortFp('AA:BB')).toBe('AA:BB');
    expect(shortFp(null)).toBe('—');
  });

  test('eventLabel humanizes known kinds', () => {
    expect(eventLabel('minted')).toBe('Key minted');
    expect(eventLabel('qber-abort')).toBe('QBER abort');
  });
});
