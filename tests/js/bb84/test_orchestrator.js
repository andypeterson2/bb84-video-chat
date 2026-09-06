/**
 * BB84Orchestrator — the seam between key production and the WebRTC transport.
 *
 * This suite exists because that seam had no coverage at all: the orchestrator
 * handed each derived key to a method WebRTCManager never defined, so keys were
 * silently dropped and the video was never encrypted. The fake peer rejects any
 * method the REAL WebRTCManager does not define, so that class of bug cannot
 * come back. The engine now streams continuously, so tests wait for keys to
 * mint rather than driving discrete rounds.
 */
import { BB84Orchestrator } from '../../../website/client/static/js/bb84/orchestrator.js';
import { WebRTCManager } from '../../../website/client/static/js/webrtc.js';
import { orchestratorPair, USED_METHODS, fastTimers, clearTimers } from './harness.js';

async function pair(options = {}) {
  const p = orchestratorPair(options);
  await p.init();
  return p;
}

beforeEach(fastTimers);
afterEach(clearTimers);

describe('BB84Orchestrator ↔ WebRTCManager contract', () => {
  test('every WebRTCManager method the orchestrator calls actually exists', () => {
    for (const method of USED_METHODS) {
      expect(typeof WebRTCManager.prototype[method]).toBe('function');
    }
  });

  test('setEncryptionKey takes the (rawKey, keyIndex) pair the orchestrator sends', () => {
    expect(WebRTCManager.prototype.setEncryptionKey).toHaveLength(2);
  });
});

describe('BB84Orchestrator key production', () => {
  test('streaming mints one matching key on both peers', async () => {
    const p = await pair();
    try {
      await p.untilMinted(1);
      expect(p.installed.alice[0].keyIndex).toBe(0);
      expect(p.installed.bob[0].keyIndex).toBe(0);
      // 128-bit key, identical on both sides, or the peers cannot talk.
      expect(p.installed.alice[0].key).toHaveLength(16);
      expect(Array.from(p.installed.alice[0].key)).toEqual(Array.from(p.installed.bob[0].key));
      // Reservoir telemetry surfaced healthy frames.
      const frame = p.phases('alice', 'reservoir').at(-1);
      expect(frame.qber).toBeLessThan(0.11);
      expect(frame.accepted).toBe(true);
    } finally {
      p.destroy();
    }
  });

  test('the reservoir keeps minting, advancing the key index', async () => {
    const p = await pair();
    try {
      await p.untilMinted(3);
      expect(p.installed.alice.slice(0, 3).map((k) => k.keyIndex)).toEqual([0, 1, 2]);
      for (let i = 0; i < 3; i++) {
        expect(Array.from(p.installed.alice[i].key)).toEqual(Array.from(p.installed.bob[i].key));
      }
    } finally {
      p.destroy();
    }
  });

  test('an eavesdropper drives per-frame QBER past 11% and no key is installed', async () => {
    const p = await pair();
    try {
      p.alice.setEavesdropper(true);
      expect(p.alice.eavesdropperEnabled).toBe(true);
      await p.waitFor(() => {
        expect(p.phases('alice', 'exhausted').length).toBeGreaterThanOrEqual(1);
      });
      const failed = p.phases('alice', 'failed');
      expect(failed.length).toBeGreaterThanOrEqual(3);
      for (const f of failed) expect(f.reason).toBe('qber-exceeded');
      expect(p.installed.alice).toHaveLength(0);
      expect(p.installed.bob).toHaveLength(0);
    } finally {
      p.destroy();
    }
  });

  test('removing the eavesdropper recovers the channel and mints again', async () => {
    const p = await pair();
    try {
      p.alice.setEavesdropper(true);
      await p.waitFor(() => {
        expect(p.phases('alice', 'exhausted').length).toBeGreaterThanOrEqual(1);
      });
      expect(p.installed.alice).toHaveLength(0);

      p.alice.setEavesdropper(false);
      await p.untilMinted(1);
      expect(Array.from(p.installed.alice[0].key)).toEqual(Array.from(p.installed.bob[0].key));
    } finally {
      p.destroy();
    }
  });
});

describe('BB84Orchestrator reservoir telemetry', () => {
  test('a healthy call emits mode, sas, reservoir, minted and rotated events', async () => {
    const p = await pair({
      aliceToken: 'kRYfDKu2PNjHsguWlukncg',
      bobToken: 'kRYfDKu2PNjHsguWlukncg',
    });
    try {
      await p.untilMinted(1);
      expect(p.phases('alice', 'mode').at(-1).mode).toBe('sim');
      expect(p.phases('alice', 'sas')).toHaveLength(1);
      expect(p.phases('alice', 'reservoir').length).toBeGreaterThan(0);
      expect(p.phases('alice', 'minted').length).toBeGreaterThanOrEqual(1);
      await p.waitFor(() => {
        expect(p.phases('alice', 'rotated').length).toBeGreaterThanOrEqual(1);
      });
    } finally {
      p.destroy();
    }
  });
});

describe('BB84Orchestrator liveness', () => {
  test('a silent peer trips the stream watchdog: a failed session, not a hang', async () => {
    globalThis.QVC_STREAM_WATCHDOG_MS = 150;
    const states = [];
    const orch = new BB84Orchestrator({
      webrtcManager: {
        sendData: () => {},
        setEncryptionKey: () => {},
        getDtlsFingerprints: () => ({ local: 'A', remote: 'B' }),
      },
      onStateChange: (s) => states.push(s),
    });
    // Detector role (joiner) with no peer: no frame-open ever arrives.
    await orch.init({ isInitiator: false });
    try {
      await vi.waitFor(
        () => {
          expect(states.some((s) => s.phase === 'failed' && s.reason === 'timeout')).toBe(true);
        },
        { timeout: 3000, interval: 20 },
      );
    } finally {
      orch.destroy();
    }
  });

  test('destroy mid-stream settles everything, and re-init mints a fresh key', async () => {
    const p = await pair();
    try {
      await p.untilMinted(1);
      p.alice.destroy();
      p.bob.destroy();
      const before = p.installed.alice.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(p.installed.alice.length).toBe(before); // no late installs

      await p.init();
      await p.untilMinted(1);
      expect(p.installed.bob.at(-1).key).toHaveLength(16);
    } finally {
      p.destroy();
    }
  });

  test('junk on the classical wire costs a session; the restart recovers', async () => {
    // Generous frame deadline so a spurious slow frame under parallel test
    // load can't stack extra failures toward the latch (this exercises the
    // restart path, not the exhausted path).
    globalThis.QVC_FRAME_DEADLINE_MS = 3000;
    const p = await pair();
    try {
      await p.untilMinted(1);
      const before = p.installed.alice.length;
      // Corrupt bob's stream: a malformed classical message desyncs the
      // session; it tears down and the source announces a fresh one.
      p.bob.handleMessage(
        JSON.stringify({ ch: 'classical', payload: { type: 'frame-open', frameId: -7 } }),
      );
      await p.waitFor(() => {
        expect(p.installed.alice.length).toBeGreaterThan(before);
        expect(p.installed.bob.length).toBeGreaterThan(before);
      }, 12000);
      const n = Math.min(p.installed.alice.length, p.installed.bob.length);
      for (let i = 0; i < n; i++) {
        expect(p.installed.alice[i].keyIndex).toBe(p.installed.bob[i].keyIndex);
        expect(Array.from(p.installed.alice[i].key)).toEqual(Array.from(p.installed.bob[i].key));
      }
    } finally {
      p.destroy();
    }
  });
});
