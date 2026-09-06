/**
 * Shared orchestrator test harness (reservoir model).
 *
 * One strict fake WebRTCManager for every orchestrator suite: any method the
 * REAL WebRTCManager does not define throws (that trap caught the key-handoff
 * API drifting once already). Two orchestrators are wired over a fake ordered
 * DataChannel; after init() both stream continuously, so tests wait for keys
 * to mint rather than driving discrete rounds.
 */
import { vi, expect } from 'vitest';
import { BB84Orchestrator } from '../../../website/client/static/js/bb84/orchestrator.js';

/** Every method the orchestrator is allowed to call on its WebRTCManager. */
export const USED_METHODS = ['sendData', 'setEncryptionKey', 'getDtlsFingerprints'];

/** Mirror-image DTLS fingerprint views, as two honest peers would report. */
export const MIRROR_FPS = {
  alice: { local: 'AA:11:AA', remote: 'BB:22:BB' },
  bob: { local: 'BB:22:BB', remote: 'AA:11:AA' },
};

/** Fast timing so the continuous engine runs in milliseconds under test. */
export function fastTimers() {
  globalThis.QVC_FRAME_PERIOD_MS = 3;
  globalThis.QVC_FRAME_DEADLINE_MS = 600;
  globalThis.QVC_STREAM_WATCHDOG_MS = 1200;
  globalThis.QVC_ROTATION_FLOOR_MS = 0;
  globalThis.QVC_SESSION_RESTART_DELAY_MS = 15;
}

export function clearTimers() {
  for (const k of Object.keys(globalThis).filter((n) => n.startsWith('QVC_'))) {
    delete globalThis[k];
  }
}

/**
 * Two orchestrators wired to each other over a fake ordered DataChannel.
 *
 * @param {object} [options]
 * @param {string} [options.aliceToken] - room token for alice (enables auth)
 * @param {string} [options.bobToken] - room token for bob (enables auth)
 * @param {function(string, string): string|null} [options.tamper] - given
 *   (senderName, wireData), return the (possibly altered) wire data, or null
 *   to drop the message entirely
 * @param {number} [options.slotsPerFrame]
 */
export function orchestratorPair({
  aliceToken = null,
  bobToken = null,
  tamper = null,
  slotsPerFrame = 2048,
} = {}) {
  const installed = { alice: [], bob: [] };
  const states = { alice: [], bob: [] };
  const fpCalls = { alice: 0, bob: 0 };
  const peers = {};

  const transport = (self, other) =>
    new Proxy(
      {
        sendData: (data) => {
          const wire = tamper ? tamper(self, data) : data;
          if (wire === null) return;
          Promise.resolve().then(() => peers[other] && peers[other].handleMessage(wire));
        },
        setEncryptionKey: (key, keyIndex) => installed[self].push({ key, keyIndex }),
        getDtlsFingerprints: () => {
          fpCalls[self]++;
          return MIRROR_FPS[self];
        },
      },
      {
        get(target, prop) {
          if (typeof prop === 'string' && !(prop in target)) {
            throw new Error(
              `orchestrator called webrtc.${prop}(), which WebRTCManager does not define`,
            );
          }
          return target[prop];
        },
      },
    );

  peers.alice = new BB84Orchestrator({
    webrtcManager: transport('alice', 'bob'),
    onStateChange: (s) => states.alice.push(s),
    slotsPerFrame,
  });
  peers.bob = new BB84Orchestrator({
    webrtcManager: transport('bob', 'alice'),
    onStateChange: (s) => states.bob.push(s),
    slotsPerFrame,
  });

  const phases = (side, phase) => states[side].filter((s) => s.phase === phase);

  return {
    alice: peers.alice,
    bob: peers.bob,
    installed,
    states,
    fpCalls,
    phases,
    /** (Re-)initialize and start both sides. */
    init: async () => {
      await peers.alice.init({ roomToken: aliceToken, isInitiator: true });
      await peers.bob.init({ roomToken: bobToken, isInitiator: false });
    },
    /** Wait until both sides have installed at least `n` keys. */
    untilMinted: (n, timeout = 8000) =>
      vi.waitFor(
        () => {
          expect(installed.alice.length).toBeGreaterThanOrEqual(n);
          expect(installed.bob.length).toBeGreaterThanOrEqual(n);
        },
        { timeout, interval: 20 },
      ),
    /** Wait for an arbitrary predicate over both sides' state. */
    waitFor: (fn, timeout = 8000) => vi.waitFor(fn, { timeout, interval: 20 }),
    destroy: () => {
      peers.alice.destroy();
      peers.bob.destroy();
    },
  };
}
