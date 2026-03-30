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

    const [aliceResult, bobResult] = await Promise.all([
      alice.runAsAlice(),
      bob.runAsBob(),
    ]);

    expect(aliceResult.key).not.toBeNull();
    expect(bobResult.key).not.toBeNull();
    expect(aliceResult.key).toHaveLength(16); // 128 bits = 16 bytes
    expect(bobResult.key).toHaveLength(16);

    // Keys must match
    for (let i = 0; i < aliceResult.key.length; i++) {
      expect(aliceResult.key[i]).toBe(bobResult.key[i]);
    }
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

      const [aliceResult] = await Promise.all([
        alice.runAsAlice(),
        bob.runAsBob(),
      ]);

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
    const result = proto._privacyAmplify(bits, 128);
    expect(result).toHaveLength(128);
    // All values should be 0 or 1
    for (const b of result) {
      expect(b === 0 || b === 1).toBe(true);
    }
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

    const [aliceResult, bobResult] = await Promise.all([
      alice.runAsAlice(),
      bob.runAsBob(),
    ]);

    // At least one side should reject (return null key)
    const rejected = aliceResult.key === null || bobResult.key === null;
    expect(rejected).toBe(true);
    expect(aliceResult.metrics.isSecure).toBe(false);
  });
});
