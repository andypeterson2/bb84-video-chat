/**
 * ReservoirEngine over the loopback backend — two engines wired through
 * real DataChannelMux instances, exactly the transport shape the app uses.
 * Covers: continuous minting, rotation floor, pool cap/flow control, Eve
 * gating + latch + recovery, session restart on junk, destroy liveness.
 */
import {
  DataChannelMux,
  DataChannelClassicalChannel,
} from '../../../website/client/static/js/bb84/datachannel-adapter.js';
import {
  ReservoirEngine,
  encodePeerDetections,
} from '../../../website/client/static/js/bench/reservoir.js';
import { LoopbackFrameSource } from '../../../website/client/static/js/bench/loopback-source.js';

beforeEach(() => {
  // Real-time defaults are for humans; tests run the same machinery fast.
  globalThis.QVC_FRAME_PERIOD_MS = 5;
  globalThis.QVC_FRAME_DEADLINE_MS = 800;
  globalThis.QVC_STREAM_WATCHDOG_MS = 1500;
  globalThis.QVC_ROTATION_FLOOR_MS = 0;
  globalThis.QVC_SESSION_RESTART_DELAY_MS = 20;
});

afterEach(() => {
  for (const k of Object.keys(globalThis).filter((n) => n.startsWith('QVC_'))) {
    delete globalThis[k];
  }
});

function enginePair({ slotsPerFrame = 2048 } = {}) {
  const muxes = {};
  const installed = { source: [], detector: [] };
  const states = { source: [], detector: [] };
  const engines = {};
  // In-memory messages are already queued when a receive runs, so its deadline
  // never fires. `link.delay` makes receives actually wait, as a real link does.
  const link = { delay: 0 };

  for (const [self, other] of [
    ['source', 'detector'],
    ['detector', 'source'],
  ]) {
    muxes[self] = new DataChannelMux((raw) => {
      if (!link.delay) return Promise.resolve().then(() => muxes[other]?.handleMessage(raw));
      return new Promise((resolve) =>
        setTimeout(() => {
          muxes[other]?.handleMessage(raw);
          resolve();
        }, link.delay),
      );
    });
  }

  const sourceFs = new LoopbackFrameSource({
    role: 'source',
    sendToPeer: (d) => muxes.source.send('quantum', encodePeerDetections(d)),
  });
  const detectorFs = new LoopbackFrameSource({ role: 'detector' });

  for (const [self, fs] of [
    ['source', sourceFs],
    ['detector', detectorFs],
  ]) {
    engines[self] = new ReservoirEngine({
      mux: muxes[self],
      makeClassicalChannel: (_domain, signal, muxChannel) =>
        new DataChannelClassicalChannel(muxes[self], signal, muxChannel),
      frameSource: fs,
      installKey: (key, keyIndex) => installed[self].push({ key, keyIndex }),
      onState: (s) => states[self].push(s),
      slotsPerFrame,
    });
  }

  const phases = (side, phase) => states[side].filter((s) => s.phase === phase);
  return {
    engines,
    muxes,
    link,
    installed,
    states,
    phases,
    sourceFs,
    start: () => {
      engines.source.start();
      engines.detector.start();
    },
    destroy: () => {
      engines.source.destroy();
      engines.detector.destroy();
    },
    untilInstalled: (n, timeout = 8000) =>
      vi.waitFor(
        () => {
          expect(installed.source.length).toBeGreaterThanOrEqual(n);
          expect(installed.detector.length).toBeGreaterThanOrEqual(n);
        },
        { timeout, interval: 25 },
      ),
  };
}

describe('reservoir streaming', () => {
  test('frames stream, keys mint, and both sides install identical keys', async () => {
    const p = enginePair();
    try {
      p.start();
      await p.untilInstalled(2);

      expect(p.installed.source[0].keyIndex).toBe(0);
      expect(p.installed.detector[0].keyIndex).toBe(0);
      for (let i = 0; i < 2; i++) {
        expect(p.installed.source[i].key).toHaveLength(16);
        expect(Array.from(p.installed.source[i].key)).toEqual(
          Array.from(p.installed.detector[i].key),
        );
      }
      // Telemetry carried frame events with sane shapes.
      const frame = p.phases('source', 'frame').at(-1);
      expect(frame.qber).toBeLessThan(0.11);
      expect(frame.accepted).toBe(true);
      expect(frame.pooledBits).toBeGreaterThanOrEqual(0);
    } finally {
      p.destroy();
    }
  });

  test('a frame too small to sample is rejected, not pooled as error-free', async () => {
    // 64 slots yields only a couple of sifted bits, so the sample comes out
    // empty and the frame is unmeasurable. Three in a row latch the engine.
    const p = enginePair({ slotsPerFrame: 64 });
    try {
      p.start();
      await vi.waitFor(
        () => {
          expect(p.phases('source', 'exhausted').length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 8000, interval: 25 },
      );

      const failures = p.phases('source', 'failed');
      expect(failures.length).toBeGreaterThanOrEqual(3);
      expect(failures.every((f) => f.reason === 'sample-too-small')).toBe(true);

      // Nothing was accepted, nothing pooled, and no key was minted from bits
      // whose error rate nobody ever measured.
      expect(p.phases('source', 'frame').every((f) => f.accepted === false)).toBe(true);
      expect(p.phases('source', 'minted')).toHaveLength(0);
      expect(p.installed.source).toHaveLength(0);
    } finally {
      p.destroy();
    }
  });

  test('the rotation floor defers installs while minting continues', async () => {
    globalThis.QVC_ROTATION_FLOOR_MS = 60_000; // effectively: only one install
    const p = enginePair();
    try {
      p.start();
      await vi.waitFor(
        () => {
          expect(p.phases('source', 'minted').length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 8000, interval: 25 },
      );
      // First key installs immediately (floor measured from -infinity); the
      // rest wait out the floor.
      expect(p.installed.source.length).toBe(1);
      expect(p.phases('source', 'minted').length).toBeGreaterThanOrEqual(2);
    } finally {
      p.destroy();
    }
  });

  test('a full reservoir bounds the pending pool and pauses production', async () => {
    // Huge floor so no installs fire: pending keys must never exceed the cap,
    // and a full pool pauses minting instead of growing.
    globalThis.QVC_ROTATION_FLOOR_MS = 60_000;
    const p = enginePair();
    try {
      p.start();
      await vi.waitFor(
        () => {
          expect(p.phases('source', 'minted').length).toBeGreaterThanOrEqual(4);
        },
        { timeout: 8000, interval: 25 },
      );
      // The single immediate install (floor from -infinity) drains one slot,
      // so total mints may reach cap + 1; the pending depth must never exceed
      // the cap, and production settles instead of running away.
      expect(Math.max(...p.phases('source', 'minted').map((s) => s.poolDepth))).toBeLessThanOrEqual(
        4,
      );
      const settled = p.phases('source', 'minted').length;
      await new Promise((r) => setTimeout(r, 300));
      expect(p.phases('source', 'minted').length).toBeLessThanOrEqual(settled + 1);
    } finally {
      p.destroy();
    }
  });
});

describe('reservoir failure semantics', () => {
  test(
    'Eve drives per-frame QBER over threshold: no mints, latch after 3, recovery on toggle-off',
    { timeout: 20_000 },
    async () => {
      const p = enginePair();
      try {
        p.engines.source.setEavesdropper(true);
        p.start();
        await vi.waitFor(
          () => {
            expect(p.phases('source', 'exhausted').length).toBeGreaterThanOrEqual(1);
          },
          { timeout: 8000, interval: 25 },
        );
        expect(p.installed.source).toHaveLength(0);
        const failed = p.phases('source', 'failed');
        expect(failed.length).toBeGreaterThanOrEqual(3);
        for (const f of failed) expect(f.reason).toBe('qber-exceeded');
        expect(failed.at(-1).qber ?? failed[0].qber).toBeGreaterThan(0.11);

        // Toggle off at the source; the detector follows the announced session
        // restart, the latch clears and keys mint again.
        p.engines.source.setEavesdropper(false);
        await p.untilInstalled(1);
        expect(Array.from(p.installed.source[0].key)).toEqual(
          Array.from(p.installed.detector[0].key),
        );
      } finally {
        p.destroy();
      }
    },
  );

  test('junk on the classical wire costs a session, and the restart recovers', async () => {
    const p = enginePair();
    try {
      p.start();
      await p.untilInstalled(1);
      const installedBefore = p.installed.source.length;

      // Corrupt the detector's stream mid-session: a malformed classical
      // message desyncs it; the session dies and the source restarts.
      p.muxes.detector.handleMessage(
        JSON.stringify({ ch: 'classical', payload: { type: 'frame-open', frameId: -1 } }),
      );
      await vi.waitFor(
        () => {
          expect(
            p.states.detector.some((s) => s.phase === 'failed' && s.reason !== 'qber-exceeded'),
          ).toBe(true);
        },
        { timeout: 4000, interval: 25 },
      );
      await vi.waitFor(
        () => {
          expect(p.installed.source.length).toBeGreaterThan(installedBefore);
          expect(p.installed.detector.length).toBeGreaterThan(installedBefore);
        },
        { timeout: 8000, interval: 25 },
      );
      // The source installs a key a beat before the detector, so compare every
      // key both have installed rather than each side's latest.
      const n = Math.min(p.installed.source.length, p.installed.detector.length);
      for (let i = 0; i < n; i++) {
        const s = p.installed.source[i];
        const d = p.installed.detector[i];
        expect(s.keyIndex).toBe(d.keyIndex);
        expect(Array.from(s.key)).toEqual(Array.from(d.key));
      }
    } finally {
      p.destroy();
    }
  });

  test('repeated frame deadlines restart the session and never latch', async () => {
    // A blown frame deadline says nothing about the channel's security, so the
    // engine keeps restarting however often it happens.
    globalThis.QVC_FRAME_DEADLINE_MS = 40;
    globalThis.QVC_SESSION_RESTART_DELAY_MS = 5;
    const p = enginePair();
    try {
      p.link.delay = 120; // every receive outlives the frame deadline
      p.start();
      await vi.waitFor(
        () => {
          const timeouts = p
            .phases('source', 'failed')
            .filter((f) => f.reason === 'timeout' || f.reason === 'protocol');
          expect(timeouts.length).toBeGreaterThanOrEqual(5);
        },
        { timeout: 10_000, interval: 25 },
      );

      // Well past MAX_CONSECUTIVE_FAILURES, and still not latched.
      expect(p.phases('source', 'exhausted')).toHaveLength(0);
      expect(p.engines.source._exhausted).toBe(false);

      // Let the link recover and the engine still mints — no manual reset.
      p.link.delay = 0;
      globalThis.QVC_FRAME_DEADLINE_MS = 2000;
      await p.untilInstalled(1);
    } finally {
      p.destroy();
    }
  });

  test('destroy mid-stream settles everything — no hangs, no late installs', async () => {
    const p = enginePair();
    p.start();
    await p.untilInstalled(1);
    p.destroy();
    const count = p.installed.source.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(p.installed.source.length).toBe(count);
  });

  test('a silent peer trips the stream watchdog, not a hang', async () => {
    globalThis.QVC_STREAM_WATCHDOG_MS = 200;
    const p = enginePair();
    try {
      // Only the detector starts: no frame-open ever arrives.
      p.engines.detector.start();
      await vi.waitFor(
        () => {
          expect(
            p.states.detector.some((s) => s.phase === 'failed' && s.reason === 'timeout'),
          ).toBe(true);
        },
        { timeout: 4000, interval: 25 },
      );
    } finally {
      p.destroy();
    }
  });
});
