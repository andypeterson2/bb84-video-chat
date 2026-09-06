/**
 * Pooled distillation: both ends must mint identical keys, correction must
 * actually correct, the verification hash must catch divergence, and every
 * disclosed bit must be budgeted.
 */
import {
  distillSource,
  distillDetector,
  mintable,
  leakage,
  privacyAmplify,
  DistillError,
  PARITY_BLOCK_SIZE,
  VERIFY_HASH_BITS,
} from '../../../website/client/static/js/bench/distill.js';
import { randomBits } from '../../../website/client/static/js/bench/packing.js';

/** Two in-memory typed streams wired to each other. */
function ioPair() {
  const queues = [[], []];
  const waiters = [[], []];
  const deliver = (side, msg) => {
    const w = waiters[side].shift();
    if (w) w(msg);
    else queues[side].push(msg);
  };
  const make = (mine, theirs) => ({
    send: Object.assign(async (msg) => deliver(theirs, msg), {
      // Test helper: inject a message INTO this side, as if the peer sent it.
      peerInject: async (msg) => deliver(mine, msg),
    }),
    receive: async (types) => {
      const msg =
        queues[mine].length > 0
          ? queues[mine].shift()
          : await new Promise((resolve) => waiters[mine].push(resolve));
      if (!types.includes(msg.type)) throw new Error(`unexpected ${msg.type}`);
      return msg;
    },
  });
  return [make(0, 1), make(1, 0)];
}

describe('mint budget accounting', () => {
  test('leakage counts parities AND the verification hash', () => {
    expect(leakage(800)).toBe(Math.ceil(800 / PARITY_BLOCK_SIZE) + VERIFY_HASH_BITS);
  });

  test('mintable only when the pool covers target plus all disclosure', () => {
    expect(mintable(128, 128)).toBe(false);
    expect(mintable(300, 128)).toBe(true);
    expect(mintable(220, 128)).toBe(true); // 220 − (28 parities + 64 hash) = 128 exactly
    expect(mintable(219, 128)).toBe(false); // one bit short
  });
});

describe('distillation', () => {
  test('a clean pool mints identical keys on both ends', async () => {
    const pool = Array.from(randomBits(600));
    const [a, b] = ioPair();
    const [srcKey, detKey] = await Promise.all([
      distillSource([...pool], a, { mintId: 0 }),
      distillDetector([...pool], b, { mintId: 0 }),
    ]);
    expect(srcKey).toHaveLength(16);
    expect(Array.from(detKey)).toEqual(Array.from(srcKey));
  });

  test('a single flipped bit is corrected and keys still match', async () => {
    const pool = Array.from(randomBits(600));
    const noisy = [...pool];
    noisy[40] ^= 1; // first bit of block 5 — exactly what block parity fixes
    const [a, b] = ioPair();
    const [srcKey, detKey] = await Promise.all([
      distillSource([...pool], a, { mintId: 1 }),
      distillDetector(noisy, b, { mintId: 1 }),
    ]);
    expect(Array.from(detKey)).toEqual(Array.from(srcKey));
  });

  test('uncorrectable divergence trips the verification hash, never mints', async () => {
    const pool = Array.from(randomBits(600));
    const noisy = [...pool];
    // Two errors in one block: parity matches, correction is blind to it —
    // the exact failure class the verification hash exists to catch.
    noisy[81] ^= 1;
    noisy[82] ^= 1;
    const [a, b] = ioPair();
    const results = await Promise.allSettled([
      distillSource([...pool], a, { mintId: 2 }),
      distillDetector(noisy, b, { mintId: 2 }),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[0].reason).toBeInstanceOf(DistillError);
    expect(results[0].reason.reason).toBe('verify');
    expect(results[1].status).toBe('rejected');
  });

  test('a pool below budget refuses to mint at all', async () => {
    const [a] = ioPair();
    await expect(distillSource(Array.from(randomBits(100)), a, { mintId: 3 })).rejects.toThrow(
      /budget/,
    );
  });

  test('mint ids are enforced on every message', async () => {
    const pool = Array.from(randomBits(600));
    const [, b] = ioPair();
    // Feed the detector a parities message from the WRONG mint.
    const detector = distillDetector([...pool], b, { mintId: 5 });
    await b.send.peerInject({ type: 'mint-parities', mintId: 4, parities: 'AAAA' });
    await expect(detector).rejects.toThrow(/mint id mismatch/);
  });
});

describe('privacy amplification', () => {
  test('is deterministic in (bits, seed) and seed-sensitive', () => {
    const bits = Array.from(randomBits(300));
    bits[0] = 1; // guarantee the flipped diagonal below is actually consumed
    const seed = Array.from(randomBits(300 + 127));
    const one = privacyAmplify(bits, 128, seed);
    expect(privacyAmplify(bits, 128, seed)).toEqual(one);
    const otherSeed = [...seed];
    otherSeed[bits.length - 1] ^= 1; // T[0][0]'s diagonal — gated by bits[0]=1
    expect(privacyAmplify(bits, 128, otherSeed)).not.toEqual(one);
  });

  test('rejects a wrong-length seed', () => {
    expect(() => privacyAmplify([1, 0, 1], 128, [1, 0])).toThrow(DistillError);
  });
});
