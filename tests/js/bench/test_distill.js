/**
 * Pooled distillation: both ends must mint identical keys, Cascade must
 * correct errors wherever they fall, the verification hash must catch
 * divergence, and every disclosed bit must be budgeted and bounded.
 */
import {
  distillSource,
  distillDetector,
  mintable,
  leakage,
  cascadeBlockSizes,
  privacyAmplify,
  DistillError,
  CASCADE_PASSES,
  VERIFY_HASH_BITS,
} from '../../../website/client/static/js/bench/distill.js';
import { randomBits, packBits, toB64 } from '../../../website/client/static/js/bench/packing.js';

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

describe('cascade schedule', () => {
  test('first block ≈ 0.73 / QBER, doubling each pass, capped at half the pool', () => {
    expect(cascadeBlockSizes(2000, 0.05)).toEqual([15, 30, 60, 120, 240, 480]);
    expect(cascadeBlockSizes(2000, 0.01)).toEqual([64, 128, 256, 512, 1000, 1000]);
    expect(cascadeBlockSizes(2000, 0.01)).toHaveLength(CASCADE_PASSES);
  });

  test('small pools keep at least 16 first-pass blocks', () => {
    expect(cascadeBlockSizes(500, 0.01)[0]).toBe(31);
  });
});

describe('mint budget accounting', () => {
  test('leakage counts every pass of parities, bisection, AND the verification hash', () => {
    const blockParities = cascadeBlockSizes(800).reduce((sum, k) => sum + Math.ceil(800 / k), 0);
    expect(leakage(800)).toBeGreaterThan(blockParities + VERIFY_HASH_BITS);
  });

  test('a noisier pool needs more bits before it can mint', () => {
    expect(leakage(1000, 0.08)).toBeGreaterThan(leakage(1000, 0.02));
    expect(mintable(1000, 128, 0.02)).toBe(true);
    expect(mintable(600, 128, 0.11)).toBe(false);
  });

  test('mintable only when the pool covers target plus expected disclosure', () => {
    expect(mintable(128, 128)).toBe(false);
    const n = Array.from({ length: 2000 }, (_, i) => i).find((len) => mintable(len, 128));
    expect(n - leakage(n)).toBeGreaterThanOrEqual(128);
    expect(n - 1 - leakage(n - 1)).toBeLessThan(128);
  });
});

/** Deterministic PRNG so a failing error pattern can be replayed. */
function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flip exactly round(qber × n) distinct, uniformly placed bits. */
function withErrors(pool, qber, seed) {
  const rand = seededRandom(seed);
  const noisy = [...pool];
  const positions = new Set();
  while (positions.size < Math.round(qber * pool.length)) {
    positions.add(Math.floor(rand() * pool.length));
  }
  for (const i of positions) noisy[i] ^= 1;
  return noisy;
}

describe('reconciliation at realistic QBER', () => {
  test.each([
    [0.01, 11],
    [0.03, 12],
    [0.05, 13],
    [0.08, 14],
    [0.11, 15],
  ])('errors at random positions (QBER %f) are corrected and keys match', async (qber, seed) => {
    const pool = Array.from(randomBits(2000));
    const noisy = withErrors(pool, qber, seed);
    const [a, b] = ioPair();
    const [srcKey, detKey] = await Promise.all([
      distillSource([...pool], a, { mintId: 10, qber }),
      distillDetector(noisy, b, { mintId: 10 }),
    ]);
    expect(Array.from(detKey)).toEqual(Array.from(srcKey));
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
    noisy[43] ^= 1;
    const [a, b] = ioPair();
    const [srcKey, detKey] = await Promise.all([
      distillSource([...pool], a, { mintId: 1 }),
      distillDetector(noisy, b, { mintId: 1 }),
    ]);
    expect(Array.from(detKey)).toEqual(Array.from(srcKey));
  });

  test('residual divergence trips the verification hash, never mints', async () => {
    const pool = Array.from(randomBits(600));
    const [a, b] = ioPair();
    // A detector that skips correction and reports its uncorrected pool: the
    // failure class the verification hash exists to catch.
    const source = distillSource([...pool], a, { mintId: 2, qber: 0.02 });
    await b.receive(['mint-cascade']);
    await b.send({ type: 'mint-corrected', mintId: 2 });
    await b.send({ type: 'mint-verify', mintId: 2, hash: 'not-the-hash' });
    await expect(source).rejects.toMatchObject({ name: 'DistillError', reason: 'verify' });
    const verdict = await b.receive(['mint-verdict']);
    expect(verdict.ok).toBe(false);
  });

  test('the source stops answering once disclosure would exceed the key budget', async () => {
    const pool = Array.from(randomBits(600));
    const [a, b] = ioPair();
    const source = distillSource([...pool], a, { mintId: 6, qber: 0.02 });
    await b.receive(['mint-cascade']);
    // Single-bit "parities" are the pool itself; the budget must cut this off.
    let answered = 0;
    for (let start = 0; start < pool.length; start += 50) {
      const ranges = [];
      for (let i = start; i < start + 50; i++) ranges.push(0, i, i + 1);
      await b.send({ type: 'mint-parity-query', mintId: 6, ranges });
      const reply = await b.receive(['mint-parity-reply', 'mint-abort']);
      if (reply.type === 'mint-abort') break;
      answered += 50;
    }
    await expect(source).rejects.toMatchObject({ reason: 'budget' });
    expect(answered).toBeLessThanOrEqual(pool.length - VERIFY_HASH_BITS - 128);
  });

  test('malformed or out-of-range parity queries are rejected', async () => {
    const [a, b] = ioPair();
    const source = distillSource(Array.from(randomBits(600)), a, { mintId: 7, qber: 0.02 });
    await b.receive(['mint-cascade']);
    await b.send({ type: 'mint-parity-query', mintId: 7, ranges: [0, 10, 5000] });
    await expect(source).rejects.toMatchObject({ reason: 'protocol' });
  });

  test('a malformed cascade setup is rejected by the detector', async () => {
    const [, b] = ioPair();
    const detector = distillDetector(Array.from(randomBits(600)), b, { mintId: 8 });
    await b.send.peerInject({
      type: 'mint-cascade',
      mintId: 8,
      blockSizes: [0, 0, 0],
      permSeed: toB64(packBits(Array.from(randomBits(128)))),
    });
    await expect(detector).rejects.toMatchObject({ reason: 'protocol' });
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
    // Feed the detector a cascade setup from the WRONG mint.
    const detector = distillDetector([...pool], b, { mintId: 5 });
    await b.send.peerInject({ type: 'mint-cascade', mintId: 4, blockSizes: [], permSeed: '' });
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
