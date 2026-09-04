/**
 * Channel authentication — the MAC + SAS layer under the BB84 classical channel.
 *
 * Covers: cross-side MAC agreement, tamper/replay/wrong-token aborts, the full
 * protocol over authenticated channels, SAS equality, and the orchestrator's
 * latched auth-failure (no retry).
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
import { BB84Orchestrator } from '../../../website/client/static/js/bb84/orchestrator.js';

const TOKEN = 'kRYfDKu2PNjHsguWlukncg';

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

  test('SAS freezes after first derivation and differs for different transcripts', async () => {
    const authA = await ChannelAuth.create(TOKEN, 'initiator');
    authA.noteTranscript('tag-one', 'initiator');
    const first = await authA.sas('F1', 'F2');
    authA.noteTranscript('tag-two', 'joiner');
    expect(await authA.sas('F1', 'F2')).toEqual(first);

    const authOther = await ChannelAuth.create(TOKEN, 'initiator');
    authOther.noteTranscript('a-DIFFERENT-tag', 'initiator');
    const other = await authOther.sas('F1', 'F2');
    expect(other).not.toEqual(first);
  });

  test('the same tags in a different direction produce a different SAS', async () => {
    const one = await ChannelAuth.create(TOKEN, 'initiator');
    one.noteTranscript('tag-x', 'initiator');
    const two = await ChannelAuth.create(TOKEN, 'initiator');
    two.noteTranscript('tag-x', 'joiner');
    expect(await one.sas('F1', 'F2')).not.toEqual(await two.sas('F1', 'F2'));
  });
});

describe('Orchestrator auth integration', () => {
  /** Authenticated orchestrator pair with mirror-image DTLS fingerprints. */
  async function authPair({ bobToken = TOKEN, tamper = null } = {}) {
    const installed = { alice: [], bob: [] };
    const states = { alice: [], bob: [] };
    const peers = {};

    const fps = {
      alice: { local: 'AA:11:AA', remote: 'BB:22:BB' },
      bob: { local: 'BB:22:BB', remote: 'AA:11:AA' },
    };
    const transport = (self, other) => ({
      sendData: (data) => {
        const wire = tamper ? tamper(self, data) : data;
        if (wire === null) return;
        Promise.resolve().then(() => peers[other] && peers[other].handleMessage(wire));
      },
      setEncryptionKey: (key, keyIndex) => installed[self].push({ key, keyIndex }),
      getDtlsFingerprints: () => fps[self],
    });

    peers.alice = new BB84Orchestrator({
      webrtcManager: transport('alice', 'bob'),
      onStateChange: (s) => states.alice.push(s),
    });
    peers.bob = new BB84Orchestrator({
      webrtcManager: transport('bob', 'alice'),
      onStateChange: (s) => states.bob.push(s),
    });
    await peers.alice.init({ roomToken: TOKEN, isInitiator: true });
    await peers.bob.init({ roomToken: bobToken, isInitiator: false });

    return {
      alice: peers.alice,
      bob: peers.bob,
      installed,
      states,
      round: () => Promise.all([peers.alice.runRound(true), peers.bob.runRound(false)]),
      destroy: () => {
        peers.alice.destroy();
        peers.bob.destroy();
      },
    };
  }

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

  test('a wrong join token fails as auth-failure with no key and no retry', async () => {
    const p = await authPair({ bobToken: 'attacker-token' });
    try {
      await p.round();
      const failed = [...p.states.alice, ...p.states.bob].filter(
        (s) => s.phase === 'failed' && s.reason === 'auth-failure',
      );
      expect(failed.length).toBeGreaterThan(0);
      expect(p.installed.alice).toHaveLength(0);
      expect(p.installed.bob).toHaveLength(0);
      // Latched: another round attempt is refused outright.
      await p.alice.runRound(true);
      expect(p.states.alice.filter((s) => s.phase === 'running').length).toBe(1);
    } finally {
      p.destroy();
    }
  });

  test('tampering with a classical message mid-call fails as auth-failure', async () => {
    const tamper = (self, data) => {
      const msg = JSON.parse(data);
      if (msg.ch === 'classical' && self === 'alice') {
        msg.payload.payload = JSON.stringify({ type: 'evil' });
        return JSON.stringify(msg);
      }
      return data;
    };
    const p = await authPair({ tamper });
    try {
      // Alice legitimately blocks waiting for a peer who refused her tampered
      // message — await only Bob (the side that detects the tampering).
      void p.alice.runRound(true);
      await p.bob.runRound(false);
      const failed = p.states.bob.find((s) => s.phase === 'failed' && s.reason === 'auth-failure');
      expect(failed).toBeTruthy();
      expect(p.installed.bob).toHaveLength(0);
    } finally {
      p.destroy();
    }
  });
});
