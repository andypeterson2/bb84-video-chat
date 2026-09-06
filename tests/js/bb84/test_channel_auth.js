/**
 * Channel authentication — the MAC + SAS layer under the BB84 classical channel.
 *
 * Covers: cross-side MAC agreement, tamper/replay/wrong-token aborts, the full
 * protocol over authenticated channels, the pure fingerprint-bound SAS, and the
 * orchestrator's retry-then-latch integrity semantics (a single fault costs one
 * round; only persistent failure latches, via the exhausted path).
 */
import { describe, test, expect } from 'vitest';
import {
  ChannelAuth,
  ChannelAuthError,
  AuthenticatedClassicalChannel,
} from '../../../website/client/static/js/bb84/channel-auth.js';
import {
  DataChannelMux,
  DataChannelClassicalChannel,
} from '../../../website/client/static/js/bb84/datachannel-adapter.js';
import { BB84Protocol } from '../../../website/client/static/js/bb84/protocol.js';
import { orchestratorPair } from './harness.js';

const TOKEN = 'kRYfDKu2PNjHsguWlukncg';

beforeEach(() => {
  // Real 60s/5s waits would make the failure-path tests unrunnable.
  globalThis.QVC_ROUND_DEADLINE_MS = 400;
  globalThis.QVC_RETRY_DELAY_MS = 30;
});

afterEach(() => {
  delete globalThis.QVC_ROUND_DEADLINE_MS;
  delete globalThis.QVC_RETRY_DELAY_MS;
});

/** Authenticated orchestrator pair, initialized and ready. */
async function authPair(options = {}) {
  const p = orchestratorPair({ aliceToken: TOKEN, bobToken: TOKEN, ...options });
  await p.init();
  return p;
}

/** Two muxes wired together like an ordered, reliable DataChannel. */
function muxPair() {
  const peers = {};
  peers.a = new DataChannelMux((raw) => Promise.resolve().then(() => peers.b.handleMessage(raw)));
  peers.b = new DataChannelMux((raw) => Promise.resolve().then(() => peers.a.handleMessage(raw)));
  return [peers.a, peers.b];
}

async function authChannelPair(tokenA = TOKEN, tokenB = TOKEN) {
  const [muxA, muxB] = muxPair();
  const authA = await ChannelAuth.create(tokenA, 'initiator');
  const authB = await ChannelAuth.create(tokenB, 'joiner');
  return {
    a: new AuthenticatedClassicalChannel(new DataChannelClassicalChannel(muxA), authA),
    b: new AuthenticatedClassicalChannel(new DataChannelClassicalChannel(muxB), authB),
    authA,
    authB,
    muxA,
    muxB,
  };
}

describe('ChannelAuth', () => {
  test('peer roles derive matching cross keys: sign here verifies there', async () => {
    const initiator = await ChannelAuth.create(TOKEN, 'initiator');
    const joiner = await ChannelAuth.create(TOKEN, 'joiner');
    const tag = await initiator.sign('msg', 0, '{"type":"x"}');
    expect(await joiner.verify('msg', 0, '{"type":"x"}', tag)).toBe(true);
  });

  test('a different token never verifies', async () => {
    const initiator = await ChannelAuth.create(TOKEN, 'initiator');
    const joiner = await ChannelAuth.create('some-other-token', 'joiner');
    const tag = await initiator.sign('msg', 0, '{"type":"x"}');
    expect(await joiner.verify('msg', 0, '{"type":"x"}', tag)).toBe(false);
  });

  test('reflection fails: a side cannot verify its own direction key', async () => {
    const initiator = await ChannelAuth.create(TOKEN, 'initiator');
    const tag = await initiator.sign('msg', 0, 'payload');
    // The initiator verifies with the JOINER's key — its own tag must not pass.
    expect(await initiator.verify('msg', 0, 'payload', tag)).toBe(false);
  });

  test('kind and seq are domain-separated in the MAC', async () => {
    const initiator = await ChannelAuth.create(TOKEN, 'initiator');
    const joiner = await ChannelAuth.create(TOKEN, 'joiner');
    const tag = await initiator.sign('msg', 0, 'p');
    expect(await joiner.verify('fp', 0, 'p', tag)).toBe(false);
    expect(await joiner.verify('msg', 1, 'p', tag)).toBe(false);
  });
});

describe('AuthenticatedClassicalChannel', () => {
  test('round-trips messages in both directions', async () => {
    const { a, b } = await authChannelPair();
    await a.send({ type: 'hello', n: 1 });
    await b.send({ type: 'reply', n: 2 });
    expect(await b.receive()).toEqual({ type: 'hello', n: 1 });
    expect(await a.receive()).toEqual({ type: 'reply', n: 2 });
  });

  test('a tampered payload aborts with ChannelAuthError', async () => {
    const { a, b, muxA } = await authChannelPair();
    // Intercept the wire: flip the payload after signing.
    const origSend = muxA._sendFn;
    muxA._sendFn = (raw) => {
      const msg = JSON.parse(raw);
      if (msg.ch === 'classical') {
        msg.payload.payload = JSON.stringify({ type: 'evil' });
        origSend(JSON.stringify(msg));
      } else {
        origSend(raw);
      }
    };
    await a.send({ type: 'honest' });
    await expect(b.receive()).rejects.toThrow(ChannelAuthError);
  });

  test('a replayed envelope aborts on the sequence check', async () => {
    const { a, b, muxA } = await authChannelPair();
    const wires = [];
    const origSend = muxA._sendFn;
    muxA._sendFn = (raw) => {
      wires.push(raw);
      origSend(raw);
    };
    await a.send({ type: 'once' });
    expect(await b.receive()).toEqual({ type: 'once' });
    // Replay the captured wire message verbatim.
    muxA._sendFn(wires[0]);
    await expect(b.receive()).rejects.toThrow(/sequence violation/);
  });

  test('wrong-token peers abort on the first message', async () => {
    const { a, b } = await authChannelPair(TOKEN, 'attacker-guess');
    await a.send({ type: 'hello' });
    await expect(b.receive()).rejects.toThrow(/MAC verification failed/);
  });

  test('an unauthenticated injection aborts instead of being absorbed', async () => {
    const { b, muxB } = await authChannelPair();
    // Attacker without the token injects a plain (old-format) message.
    muxB.handleMessage(JSON.stringify({ ch: 'classical', payload: { type: 'abort' } }));
    await expect(b.receive()).rejects.toThrow(ChannelAuthError);
  });
});

describe('BB84 over authenticated channels', () => {
  test('the full protocol still agrees on a key, and both SAS match', async () => {
    const { a, b, authA, authB } = await authChannelPair();
    const [muxQA, muxQB] = muxPair();

    // Ideal quantum channel over a mux pair: alice sends her qubits verbatim.
    const qcA = {
      sendQubits: async (qubits) =>
        muxQA.send(
          'quantum',
          qubits.map((q) => ({ ...q, detected: true })),
        ),
    };
    const qcB = { receiveQubits: async () => muxQB.receive('quantum') };

    const alice = new BB84Protocol(qcA, a, { numRawBits: 2048 });
    const bob = new BB84Protocol(qcB, b, { numRawBits: 2048 });
    const [ra, rb] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);

    expect(ra.key).not.toBeNull();
    expect(Array.from(ra.key)).toEqual(Array.from(rb.key));

    const sasA = await authA.sas('FP-INIT', 'FP-JOIN');
    const sasB = await authB.sas('FP-INIT', 'FP-JOIN');
    expect(sasA).toEqual(sasB);
    expect(sasA.digits).toMatch(/^\d{6}$/);
    expect(sasA.emoji).toHaveLength(4);
  });

  test('the SAS is a pure function of the fingerprints — same everywhere, always', async () => {
    // The earlier transcript-bound SAS diverged between two honest sides the
    // moment their processing histories differed (a failed round, a dropped
    // message) — an honest channel then read as a permanent MITM. Purity is
    // the property that kills that class: role, instance, round count and
    // history must all be irrelevant.
    const one = await ChannelAuth.create(TOKEN, 'initiator');
    const two = await ChannelAuth.create(TOKEN, 'joiner');
    const first = await one.sas('F1', 'F2');
    expect(await one.sas('F1', 'F2')).toEqual(first); // repeated calls
    expect(await two.sas('F1', 'F2')).toEqual(first); // other role
    expect(await (await ChannelAuth.create(TOKEN, 'initiator')).sas('F1', 'F2')).toEqual(first);
  });

  test('swapping the fingerprint order changes the SAS', async () => {
    const auth = await ChannelAuth.create(TOKEN, 'initiator');
    expect(await auth.sas('F1', 'F2')).not.toEqual(await auth.sas('F2', 'F1'));
  });

  test('different fingerprints change the SAS', async () => {
    const auth = await ChannelAuth.create(TOKEN, 'initiator');
    expect(await auth.sas('F1', 'F2')).not.toEqual(await auth.sas('F1', 'MITM'));
  });
});

describe('Orchestrator auth integration', () => {
  const has = (states, pred) => states.some(pred);
  const completes = (states) => states.filter((s) => s.phase === 'complete');

  test('an authenticated round completes and reports the same SAS on both sides', async () => {
    const p = await authPair();
    try {
      await p.round();
      const doneAlice = p.states.alice.find((s) => s.phase === 'complete');
      const doneBob = p.states.bob.find((s) => s.phase === 'complete');
      expect(doneAlice).toBeTruthy();
      expect(doneBob).toBeTruthy();
      expect(doneAlice.sas).toEqual(doneBob.sas);
      expect(doneAlice.sas.digits).toMatch(/^\d{6}$/);
      expect(Array.from(p.installed.alice[0].key)).toEqual(Array.from(p.installed.bob[0].key));
    } finally {
      p.destroy();
    }
  });

  test('a wrong join token retries, then latches via the exhausted path — no key ever', async () => {
    const p = await authPair({ bobToken: 'attacker-token' });
    try {
      p.alice.runRound(true);
      await vi.waitFor(
        () => {
          expect(has(p.states.alice, (s) => s.phase === 'exhausted')).toBe(true);
          expect(has(p.states.bob, (s) => s.phase === 'exhausted')).toBe(true);
        },
        { timeout: 5000 },
      );
      // Every failure was reported as an integrity fault, never a QBER story.
      for (const side of ['alice', 'bob']) {
        const failed = p.states[side].filter((s) => s.phase === 'failed');
        expect(failed.length).toBeGreaterThan(0);
        for (const f of failed) expect(['integrity', 'timeout']).toContain(f.reason);
      }
      expect(p.installed.alice).toHaveLength(0);
      expect(p.installed.bob).toHaveLength(0);
      // Latched: another round attempt is refused outright.
      const runsBefore = p.states.alice.filter((s) => s.phase === 'running').length;
      await p.alice.runRound(true);
      expect(p.states.alice.filter((s) => s.phase === 'running').length).toBe(runsBefore);
    } finally {
      p.destroy();
    }
  });

  test('one tampered round message costs one round; the retry recovers', async () => {
    // Let the fingerprint exchange (the first two classical envelopes, one
    // per direction) through untouched, then corrupt exactly one of alice's
    // round messages.
    let aliceClassicalSends = 0;
    const tamper = (self, data) => {
      if (self !== 'alice') return data;
      const msg = JSON.parse(data);
      if (msg.ch !== 'classical') return data;
      aliceClassicalSends++;
      if (aliceClassicalSends === 2) {
        msg.payload.payload = JSON.stringify({ type: 'evil' });
        return JSON.stringify(msg);
      }
      return data;
    };
    const p = await authPair({ tamper });
    try {
      p.alice.runRound(true);
      await vi.waitFor(
        () => {
          expect(completes(p.states.alice).length).toBeGreaterThanOrEqual(1);
          expect(completes(p.states.bob).length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000 },
      );
      // Bob saw the tampering as an integrity fault (one round), not a MITM latch.
      expect(has(p.states.bob, (s) => s.phase === 'failed' && s.reason === 'integrity')).toBe(true);
      expect(has(p.states.bob, (s) => s.phase === 'exhausted')).toBe(false);
      expect(Array.from(p.installed.alice.at(-1).key)).toEqual(
        Array.from(p.installed.bob.at(-1).key),
      );
      // And the SAS both sides show is identical — no post-failure divergence.
      expect(completes(p.states.alice).at(-1).sas).toEqual(completes(p.states.bob).at(-1).sas);
    } finally {
      p.destroy();
    }
  });

  test('a dropped envelope mid-round fails that round; the retry recovers', async () => {
    let aliceClassicalSends = 0;
    const tamper = (self, data) => {
      if (self !== 'alice') return data;
      const msg = JSON.parse(data);
      if (msg.ch !== 'classical') return data;
      aliceClassicalSends++;
      return aliceClassicalSends === 2 ? null : data; // silently dropped
    };
    const p = await authPair({ tamper });
    try {
      p.alice.runRound(true);
      await vi.waitFor(
        () => {
          expect(completes(p.states.alice).length).toBeGreaterThanOrEqual(1);
          expect(completes(p.states.bob).length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000 },
      );
      expect(has([...p.states.alice, ...p.states.bob], (s) => s.phase === 'failed')).toBe(true);
      expect(Array.from(p.installed.alice.at(-1).key)).toEqual(
        Array.from(p.installed.bob.at(-1).key),
      );
    } finally {
      p.destroy();
    }
  });

  test('a plain (unauthenticated) mid-round injection costs one round, not a MITM latch', async () => {
    // Mixed-version / injected-legacy-envelope case: bob must read it as an
    // integrity fault and retry, never assert man-in-the-middle from one event.
    const p = await authPair({ bobStepDelayMs: 30 });
    try {
      p.alice.runRound(true);
      await vi.waitFor(() => {
        expect(p.states.bob.some((s) => s.phase === 'running')).toBe(true);
      });
      p.bob.handleMessage(JSON.stringify({ ch: 'classical', payload: { type: 'abort' } }));
      await vi.waitFor(
        () => {
          expect(completes(p.states.alice).length).toBeGreaterThanOrEqual(1);
          expect(completes(p.states.bob).length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000 },
      );
      expect(has(p.states.bob, (s) => s.phase === 'failed' && s.reason === 'integrity')).toBe(true);
      expect(has(p.states.bob, (s) => s.phase === 'exhausted')).toBe(false);
    } finally {
      p.destroy();
    }
  });

  test('a latched joiner recovers on the next announced good round', async () => {
    const p = await authPair();
    try {
      p.alice.setEavesdropper(true);
      p.alice.runRound(true);
      // Eve drives every round past the QBER threshold; both sides latch.
      await vi.waitFor(
        () => {
          expect(has(p.states.alice, (s) => s.phase === 'exhausted')).toBe(true);
          expect(has(p.states.bob, (s) => s.phase === 'exhausted')).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(p.installed.bob).toHaveLength(0);

      // The toggle clears the INITIATOR's latch and re-keys; the joiner never
      // self-starts, so its latch must not refuse the announced recovery round.
      p.alice.setEavesdropper(false);
      await p.round();
      expect(completes(p.states.bob).length).toBeGreaterThanOrEqual(1);
      expect(Array.from(p.installed.alice.at(-1).key)).toEqual(
        Array.from(p.installed.bob.at(-1).key),
      );
    } finally {
      p.destroy();
    }
  });

  test('destroy → init gives call #2 a fresh fingerprint exchange and a working round', async () => {
    const p = await authPair();
    try {
      await p.round();
      expect(p.fpCalls).toEqual({ alice: 1, bob: 1 });
      const firstSas = completes(p.states.alice)[0].sas;

      p.destroy();
      await p.init();
      await p.round();

      // The exchange really ran again — call #2 must not trust call #1's view.
      expect(p.fpCalls).toEqual({ alice: 2, bob: 2 });
      const secondSas = completes(p.states.alice).at(-1).sas;
      expect(secondSas).toEqual(firstSas); // same fingerprints ⇒ same (pure) SAS
      expect(p.installed.alice.at(-1).keyIndex).toBe(0); // key index reset per call
    } finally {
      p.destroy();
    }
  });

  test("call #1's exhausted latch does not leak into call #2", async () => {
    const p = await authPair({ bobToken: 'attacker-token' });
    try {
      p.alice.runRound(true);
      await vi.waitFor(
        () => {
          expect(has(p.states.alice, (s) => s.phase === 'exhausted')).toBe(true);
        },
        { timeout: 5000 },
      );

      // New call, matching tokens this time: init() must clear the latch.
      p.destroy();
      p.aliceToken = p.bobToken = TOKEN;
      await p.alice.init({ roomToken: TOKEN, isInitiator: true });
      await p.bob.init({ roomToken: TOKEN, isInitiator: false });
      await p.round();
      expect(completes(p.states.alice).length).toBeGreaterThanOrEqual(1);
      expect(Array.from(p.installed.alice.at(-1).key)).toEqual(
        Array.from(p.installed.bob.at(-1).key),
      );
    } finally {
      p.destroy();
    }
  });
});
