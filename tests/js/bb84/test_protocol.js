import { vi } from 'vitest';
import { BB84Protocol } from '../../../website/client/static/js/bb84/protocol.js';
import {
  IdealQuantumChannel,
  LoopbackClassicalChannel,
} from '../../../website/client/static/js/bb84/channel.js';

function makeChannelPair() {
  const qcAlice = new IdealQuantumChannel();
  const qcBob = new IdealQuantumChannel(qcAlice);
  qcAlice.setPeer(qcBob);

  const ccAlice = new LoopbackClassicalChannel();
  const ccBob = new LoopbackClassicalChannel(ccAlice);
  ccAlice.setPeer(ccBob);

  return { qcAlice, qcBob, ccAlice, ccBob };
}

describe('BB84Protocol', () => {
  test('BB84 over ideal channel produces matching 128-bit keys', async () => {
    const { qcAlice, qcBob, ccAlice, ccBob } = makeChannelPair();

    const alice = new BB84Protocol(qcAlice, ccAlice, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });
    const bob = new BB84Protocol(qcBob, ccBob, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });

    const [aliceResult, bobResult] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);

    expect(aliceResult.key).not.toBeNull();
    expect(bobResult.key).not.toBeNull();
    expect(aliceResult.key).toHaveLength(16); // 128 bits = 16 bytes
    expect(bobResult.key).toHaveLength(16);

    // Keys must match
    for (let i = 0; i < aliceResult.key.length; i++) {
      expect(aliceResult.key[i]).toBe(bobResult.key[i]);
    }

    // Both sides account for the parity bits error correction disclosed.
    expect(aliceResult.metrics.leakedBits).toBeGreaterThan(0);
    expect(bobResult.metrics.leakedBits).toBe(aliceResult.metrics.leakedBits);
  });

  test('sifting produces ~50% key survival rate (statistical)', async () => {
    const results = [];
    for (let round = 0; round < 5; round++) {
      const { qcAlice, qcBob, ccAlice, ccBob } = makeChannelPair();
      const alice = new BB84Protocol(qcAlice, ccAlice, {
        numRawBits: 4096,
        qberThreshold: 0.11,
        targetKeyLength: 128,
      });
      const bob = new BB84Protocol(qcBob, ccBob, {
        numRawBits: 4096,
        qberThreshold: 0.11,
        targetKeyLength: 128,
      });

      const [aliceResult] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);

      const efficiency = aliceResult.metrics.siftedBits / aliceResult.metrics.rawBits;
      results.push(efficiency);
    }

    const avgEfficiency = results.reduce((a, b) => a + b, 0) / results.length;
    // Should be around 50% +/- 10%
    expect(avgEfficiency).toBeGreaterThan(0.4);
    expect(avgEfficiency).toBeLessThan(0.6);
  });

  test('QBER estimation on identical bits returns 0', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });

    const bits = Array.from({ length: 100 }, () => Math.round(Math.random()));
    const qber = proto._estimateQber(bits, [...bits], 50);
    expect(qber).toBe(0);
  });

  test('QBER estimation on known error rate returns correct value', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });

    // Create bits with exactly 20% error rate
    const bits1 = Array.from({ length: 100 }, () => 0);
    const bits2 = Array.from({ length: 100 }, (_, i) => (i < 20 ? 1 : 0));

    // Use all 100 as sample
    const qber = proto._estimateQber(bits1, bits2, 100);
    expect(qber).toBeCloseTo(0.2, 1);
  });

  test('privacy amplification reduces key to target length', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });

    const bits = Array.from({ length: 1024 }, () => Math.round(Math.random()));
    const seed = Array.from({ length: 1024 + 128 - 1 }, () => Math.round(Math.random()));
    const result = proto._privacyAmplify(bits, 128, seed);
    expect(result).toHaveLength(128);
    // All values should be 0 or 1
    for (const b of result) {
      expect(b === 0 || b === 1).toBe(true);
    }
  });

  test('privacy amplification implements the seeded Toeplitz matrix (T[i][j] = seed[i−j+n−1])', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {});

    // With a unit-vector input e_j, the output IS column j of the matrix:
    // out[i] = T[i][j] = seed[i − j + n − 1]. Check two columns exactly.
    const n = 8;
    const m = 5;
    const seed = Array.from({ length: n + m - 1 }, (_, k) => (k * 7 + 3) % 2);
    for (const j of [0, 5]) {
      const bits = Array.from({ length: n }, (_, idx) => (idx === j ? 1 : 0));
      const out = proto._privacyAmplify(bits, m, seed);
      const expected = Array.from({ length: m }, (_, i) => seed[i - j + n - 1] & 1);
      expect(out).toEqual(expected);
    }
  });

  test('privacy amplification depends on the seed (different seed ⇒ different key)', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {});

    // bits = e_0, so out[i] = seed[i + n − 1]: the output reads the seed's
    // tail directly and any difference there must show up in the key.
    const n = 4;
    const m = 8;
    const bits = [1, 0, 0, 0];
    const seedA = Array.from({ length: n + m - 1 }, () => 0);
    const seedB = [...seedA];
    seedB[n - 1] = 1; // differs inside the window the output reads
    const outA = proto._privacyAmplify(bits, m, seedA);
    const outB = proto._privacyAmplify(bits, m, seedB);
    expect(outA).not.toEqual(outB);
  });

  test('privacy amplification output is not the two-valued checkerboard (regression)', () => {
    // The original placeholder ignored the seed and its matrix degenerated to
    // T[i][j] = (i + j) & 1 — every even row identical, every odd row its
    // complement, so 128 "key" bits carried ~2 bits of entropy. A real seeded
    // Toeplitz output alternates like that with probability ~2^-126.
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {});

    const bits = Array.from({ length: 512 }, () => Math.round(Math.random()));
    const seed = Array.from({ length: 512 + 128 - 1 }, () => Math.round(Math.random()));
    const out = proto._privacyAmplify(bits, 128, seed);
    const evens = new Set(out.filter((_, i) => i % 2 === 0));
    const odds = new Set(out.filter((_, i) => i % 2 === 1));
    expect(evens.size > 1 || odds.size > 1).toBe(true);
  });

  test('privacy amplification rejects a wrong-length or missing seed', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {});
    const bits = Array.from({ length: 16 }, () => 0);
    expect(() => proto._privacyAmplify(bits, 8)).toThrow(/Toeplitz seed/);
    expect(() => proto._privacyAmplify(bits, 8, [0, 1, 0])).toThrow(/Toeplitz seed/);
  });

  test('random bits come from the crypto RNG, not Math.random', () => {
    const { qcAlice, ccAlice } = makeChannelPair();
    const proto = new BB84Protocol(qcAlice, ccAlice, {});
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const bits = proto._randomBits(64);
    expect(spy).toHaveBeenCalled();
    expect(bits).toHaveLength(64);
    for (const b of bits) {
      expect(b === 0 || b === 1).toBe(true);
    }
    spy.mockRestore();
  });

  test('consecutive rounds produce different keys (fresh Toeplitz seed per round)', async () => {
    const keys = [];
    for (let round = 0; round < 2; round++) {
      const { qcAlice, qcBob, ccAlice, ccBob } = makeChannelPair();
      const alice = new BB84Protocol(qcAlice, ccAlice, { numRawBits: 4096 });
      const bob = new BB84Protocol(qcBob, ccBob, { numRawBits: 4096 });
      const [aliceResult, bobResult] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);
      expect(Array.from(aliceResult.key)).toEqual(Array.from(bobResult.key));
      keys.push(Array.from(aliceResult.key));
    }
    expect(keys[0]).not.toEqual(keys[1]);
  });

  test('Bob aborts the round on a malformed Toeplitz seed message', async () => {
    const { qcAlice, qcBob, ccAlice, ccBob } = makeChannelPair();

    // Corrupt the seed in flight: right type, wrong dimension.
    const originalReceive = ccBob.receive.bind(ccBob);
    ccBob.receive = async () => {
      const msg = await originalReceive();
      if (msg?.type === 'toeplitz-seed') {
        return { type: 'toeplitz-seed', seed: [0, 1] };
      }
      return msg;
    };

    const alice = new BB84Protocol(qcAlice, ccAlice, { numRawBits: 4096 });
    const bob = new BB84Protocol(qcBob, ccBob, { numRawBits: 4096 });
    const [, bobResult] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);

    expect(bobResult.key).toBeNull();
    expect(bobResult.abortReason).toBe('bad-seed');
    expect(bobResult.metrics.isSecure).toBe(false);
  });

  test('round aborts with key-budget when the corrected key cannot cover leakage + target', async () => {
    const { qcAlice, qcBob, ccAlice, ccBob } = makeChannelPair();

    // ~256 sifted bits minus a 64-bit sample leaves n≈192; minus ~24 leaked
    // parity bits that can never cover a 256-bit target, on any sift outcome.
    const opts = { numRawBits: 512, targetKeyLength: 256 };
    const alice = new BB84Protocol(qcAlice, ccAlice, opts);
    const bob = new BB84Protocol(qcBob, ccBob, opts);
    const [aliceResult, bobResult] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);

    expect(aliceResult.key).toBeNull();
    expect(aliceResult.abortReason).toBe('key-budget');
    expect(bobResult.key).toBeNull();
    expect(bobResult.abortReason).toBe('key-budget');
    expect(aliceResult.metrics.leakedBits).toBeGreaterThan(0);
  });

  test('protocol rejects round when QBER > threshold', async () => {
    const { qcAlice, qcBob, ccAlice, ccBob } = makeChannelPair();

    // Inject noise by intercepting quantum channel
    const originalReceive = qcBob.receiveQubits.bind(qcBob);
    qcBob.receiveQubits = async () => {
      const qubits = await originalReceive();
      // Flip ~25% of bits to push QBER well above threshold
      return qubits.map((q) => {
        if (Math.random() < 0.25) {
          return { ...q, bit: q.bit ^ 1 };
        }
        return q;
      });
    };

    const alice = new BB84Protocol(qcAlice, ccAlice, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });
    const bob = new BB84Protocol(qcBob, ccBob, {
      numRawBits: 4096,
      qberThreshold: 0.11,
      targetKeyLength: 128,
    });

    const [aliceResult, bobResult] = await Promise.all([alice.runAsAlice(), bob.runAsBob()]);

    // At least one side should reject (return null key)
    const rejected = aliceResult.key === null || bobResult.key === null;
    expect(rejected).toBe(true);
    expect(aliceResult.metrics.isSecure).toBe(false);
  });
});
