/**
 * Shared orchestrator test harness.
 *
 * One strict fake WebRTCManager for every orchestrator suite: any method the
 * REAL WebRTCManager does not define throws (that trap caught the key-handoff
 * API drifting once already), and rounds are driven the way the app drives
 * them — the initiator announces, the joiner only ever follows announcements.
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

const TERMINAL = new Set(['complete', 'failed', 'error']);

/**
 * Two orchestrators wired to each other over a fake ordered DataChannel.
 *
 * @param {object} [options]
 * @param {string} [options.aliceToken] - room token for alice (enables auth)
 * @param {string} [options.bobToken] - room token for bob (enables auth)
 * @param {function(string, string): string|null} [options.tamper] - given
 *   (senderName, wireData), return the (possibly altered) wire data, or null
 *   to drop the message entirely
 * @param {number} [options.bobStepDelayMs] - slow bob's pipeline (to land
 *   injections deterministically before his reads)
 */
export function orchestratorPair({
  aliceToken = null,
  bobToken = null,
  tamper = null,
  bobStepDelayMs = 0,
} = {}) {
  const installed = { alice: [], bob: [] };
  const states = { alice: [], bob: [] };
  const fpCalls = { alice: 0, bob: 0 };
  const peers = {};

  const transport = (self, other) =>
    new Proxy(
      {
        // A real DataChannel delivers asynchronously; mirror that so the two
        // protocol runs interleave the way they do in the browser.
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
  });
  peers.bob = new BB84Orchestrator({
    webrtcManager: transport('bob', 'alice'),
    onStateChange: (s) => states.bob.push(s),
    stepDelayMs: bobStepDelayMs,
  });

  const settled = (side) => states[side].filter((s) => TERMINAL.has(s.phase)).length;

  return {
    alice: peers.alice,
    bob: peers.bob,
    installed,
    states,
    fpCalls,
    /** (Re-)initialize both sides, with the configured tokens when given. */
    init: async () => {
      await peers.alice.init({ roomToken: aliceToken, isInitiator: true });
      await peers.bob.init({ roomToken: bobToken, isInitiator: false });
    },
    /**
     * Runs one round: alice initiates, bob joins via the round-start
     * announcement — exactly how the app drives it (the joiner never
     * self-starts). Resolves when both sides reach a terminal phase.
     */
    round: async () => {
      const target = settled('bob') + 1;
      await peers.alice.runRound(true);
      await vi.waitFor(() => {
        expect(settled('bob')).toBeGreaterThanOrEqual(target);
      });
    },
    // Clears the pending retry timers a failed round schedules.
    destroy: () => {
      peers.alice.destroy();
      peers.bob.destroy();
    },
  };
}
