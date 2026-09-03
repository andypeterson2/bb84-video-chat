/**
 * BB84Orchestrator — the seam between the protocol and the WebRTC transport.
 *
 * This suite exists because that seam had no coverage at all: the orchestrator
 * handed each derived key to a `enableEncryption()` method that WebRTCManager
 * never defined, so keys were silently dropped and the video was never actually
 * encrypted. Nothing failed — there was simply no test that put the two classes
 * together. The fake peer below therefore rejects any method the REAL
 * WebRTCManager does not define, so that class of bug cannot come back.
 */
import { BB84Orchestrator } from '../../../website/client/static/js/bb84/orchestrator.js';
import { WebRTCManager } from '../../../website/client/static/js/webrtc.js';

/** Every method the orchestrator is allowed to call on its WebRTCManager. */
const USED_METHODS = ['sendData', 'setEncryptionKey'];

/**
 * Two orchestrators wired to each other, each behind a fake WebRTCManager that
 * throws on any method access outside {@link USED_METHODS}.
 */
function pair() {
  const installed = { alice: [], bob: [] };
  const states = { alice: [], bob: [] };
  const peers = {};

  const transport = (self, other) =>
    new Proxy(
      {
        // A real DataChannel delivers asynchronously; mirror that so the two
        // protocol runs interleave the way they do in the browser.
        sendData: (data) => {
          Promise.resolve().then(() => peers[other] && peers[other].handleMessage(data));
        },
        setEncryptionKey: (key, keyIndex) => installed[self].push({ key, keyIndex }),
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
  });
  peers.alice.init();
  peers.bob.init();

  return {
    alice: peers.alice,
    bob: peers.bob,
    installed,
    states,
    /** Runs one round on both sides concurrently, as data-channel-open does. */
    round: () => Promise.all([peers.alice.runRound(true), peers.bob.runRound(false)]),
    // Clears the pending retry timers a failed round schedules.
    destroy: () => {
      peers.alice.destroy();
      peers.bob.destroy();
    },
  };
}

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

describe('BB84Orchestrator rounds', () => {
  test('a completed round installs one matching key on both peers', async () => {
    const p = pair();
    try {
      await p.round();

      const doneAlice = p.states.alice.find((s) => s.phase === 'complete');
      const doneBob = p.states.bob.find((s) => s.phase === 'complete');
      expect(doneAlice).toBeTruthy();
      expect(doneBob).toBeTruthy();
      expect(doneAlice.qber).toBeLessThan(0.11);

      // The key reached the encryption pipeline — the step that was broken.
      expect(p.installed.alice).toHaveLength(1);
      expect(p.installed.bob).toHaveLength(1);
      expect(p.installed.alice[0].keyIndex).toBe(0);
      expect(p.installed.bob[0].keyIndex).toBe(0);

      // 128-bit key, identical on both sides, or the peers cannot talk.
      expect(p.installed.alice[0].key).toHaveLength(16);
      expect(Array.from(p.installed.alice[0].key)).toEqual(Array.from(p.installed.bob[0].key));
    } finally {
      p.destroy();
    }
  });

  test('consecutive rounds advance the key index', async () => {
    const p = pair();
    try {
      await p.round();
      await p.round();
      expect(p.installed.alice.map((k) => k.keyIndex)).toEqual([0, 1]);
    } finally {
      p.destroy();
    }
  });

  test('an eavesdropper drives QBER past 11% and no key is installed', async () => {
    const p = pair();
    try {
      p.alice.setEavesdropper(true);
      expect(p.alice.eavesdropperEnabled).toBe(true);

      await p.round();

      const failed = p.states.alice.find((s) => s.phase === 'failed');
      expect(failed).toBeTruthy();
      expect(failed.reason).toBe('qber-exceeded');
      expect(failed.qber).toBeGreaterThan(0.11);

      // The whole point: a compromised channel yields no usable key.
      expect(p.installed.alice).toHaveLength(0);
      expect(p.installed.bob).toHaveLength(0);
    } finally {
      p.destroy();
    }
  });

  test('removing the eavesdropper lets the next round succeed again', async () => {
    const p = pair();
    try {
      p.alice.setEavesdropper(true);
      await p.round();
      expect(p.installed.alice).toHaveLength(0);

      p.alice.setEavesdropper(false);
      await p.round();

      expect(p.installed.alice).toHaveLength(1);
      expect(Array.from(p.installed.alice[0].key)).toEqual(Array.from(p.installed.bob[0].key));
    } finally {
      p.destroy();
    }
  });
});

// The live pipeline drives the on-screen stepper (Transmit → Sift → QBER →
// Correct → Amplify). These assert the phases actually emit, in order, so the
// UI can't silently fall out of step with the protocol.
describe('BB84Orchestrator live pipeline', () => {
  const progressSteps = (states) => states.filter((s) => s.phase === 'progress').map((s) => s.step);

  test('a successful round emits every phase in pipeline order', async () => {
    const p = pair();
    try {
      await p.round();
      expect(progressSteps(p.states.alice)).toEqual([
        'transmit',
        'sift',
        'qber',
        'correct',
        'amplify',
      ]);
      // 'running' opens the round before any step; 'complete' closes it.
      expect(p.states.alice[0].phase).toBe('running');
      expect(p.states.alice.at(-1).phase).toBe('complete');
    } finally {
      p.destroy();
    }
  });

  test('an eavesdropped round halts at qber with an abort phase — no correct/amplify', async () => {
    const p = pair();
    try {
      p.alice.setEavesdropper(true);
      await p.round();
      const steps = progressSteps(p.states.alice);
      expect(steps).toEqual(['transmit', 'sift', 'qber', 'abort']);
      expect(steps).not.toContain('correct');
      expect(steps).not.toContain('amplify');
    } finally {
      p.destroy();
    }
  });
});
