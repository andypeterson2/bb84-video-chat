/**
 * Pooled key distillation: Cascade error correction, verification hash,
 * Toeplitz privacy amplification.
 *
 * Runs once per mint over the accumulated (multi-frame) pool.
 *  - Cascade (Brassard & Salvail, "Secret-key reconciliation by public
 *    discussion", EUROCRYPT '93): six passes of block parities, the first
 *    block size set from the pool's QBER (k1 ≈ 0.73 / QBER) and doubling each
 *    pass up to half the pool, passes after the first over shared random
 *    permutations. Every mismatched block is bisected to its erroneous bit,
 *    and each correction re-opens the earlier-pass blocks that contain it.
 *    The detector asks, the source answers with its own parities; every
 *    answered parity is counted.
 *  - A truncated-hash key-verification exchange after correction (the
 *    epsilon_cor-correctness step of Tomamichel-Lim-Gisin-Renner), so residual
 *    errors fail the mint instead of minting divergent keys.
 *  - Disclosed parities and the verification hash are both leakage: a mint
 *    succeeds only if the pool still covers the target key after them.
 */

import { bitsToBytes, packBits, randomBits, toB64, unpackBits, fromB64 } from './packing.js';

/**
 * Cascade passes. Four is the textbook count, but on pools of a few thousand
 * bits it leaves an error pair sharing a block in every pass in a few percent
 * of mints; two more half-pool passes bring that to about two in a thousand.
 */
export const CASCADE_PASSES = 6;
/** Verification-hash length (bits) — disclosed, so budgeted as leakage. */
export const VERIFY_HASH_BITS = 64;
/** QBER assumed when the caller has no estimate for the pool. */
export const DEFAULT_QBER = 0.05;

// First-pass block bounds: small blocks leak many parities; large ones hold
// several errors, and on small pools leave too few blocks to separate them.
const MIN_FIRST_BLOCK = 4;
const MAX_FIRST_BLOCK = 64;
const MIN_BLOCKS_PER_PASS = 16;
// QBER floor for sizing blocks: an error-free sample still hides some errors.
const MIN_QBER = 0.005;
// Expected bisection parities per error, over and above one per block level,
// including the back-corrections that later passes trigger.
const PARITIES_PER_ERROR = 2.5;
const PERM_SEED_BYTES = 16;

/** A distillation failure that fails the mint and leaves the engine running. */
export class DistillError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'DistillError';
    this.reason = reason;
  }
}

/** Cascade block size for each pass, for a pool of `n` bits at `qber`. */
export function cascadeBlockSizes(n, qber = DEFAULT_QBER) {
  const q = Math.max(qber, MIN_QBER);
  const byQber = Math.max(MIN_FIRST_BLOCK, Math.ceil(0.73 / q));
  const first = Math.max(1, Math.min(MAX_FIRST_BLOCK, Math.floor(n / MIN_BLOCKS_PER_PASS), byQber));
  const cap = Math.max(1, Math.ceil(n / 2));
  return Array.from({ length: CASCADE_PASSES }, (_, i) => Math.min(first * 2 ** i, cap));
}

/**
 * Expected bits disclosed by distilling `n` bits at `qber`: every pass's
 * block parities, bisection parities for the expected errors, and the
 * verification hash. The mint re-checks the exact count after correction.
 */
export function leakage(n, qber = DEFAULT_QBER) {
  const sizes = cascadeBlockSizes(n, qber);
  const blockParities = sizes.reduce((sum, k) => sum + Math.ceil(n / k), 0);
  const errors = Math.max(qber, MIN_QBER) * n;
  const bisection = Math.ceil(errors * (Math.log2(sizes[0]) + PARITIES_PER_ERROR));
  return blockParities + bisection + VERIFY_HASH_BITS;
}

/** Whether a pool can mint a key of `target` bits after expected leakage. */
export function mintable(poolLength, target, qber = DEFAULT_QBER) {
  return poolLength - leakage(poolLength, qber) >= target;
}

/** @private truncated SHA-256 of a bit string, as base64. */
async function verifyHash(bits) {
  const digest = await crypto.subtle.digest('SHA-256', packBits(bits));
  return toB64(new Uint8Array(digest).slice(0, VERIFY_HASH_BITS / 8));
}

/** @private xoshiro128** over a 16-byte seed; the permutations it drives are public. */
function seededUint32(seed) {
  const view = new DataView(seed.buffer, seed.byteOffset, PERM_SEED_BYTES);
  let a = view.getUint32(0);
  let b = view.getUint32(4);
  let c = view.getUint32(8);
  let d = view.getUint32(12);
  if ((a | b | c | d) === 0) a = 1;
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  return () => {
    const out = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a;
    d ^= b;
    b ^= c;
    a ^= d;
    c ^= t;
    d = rotl(d, 11);
    return out;
  };
}

/** @private per-pass orders: pass 0 is the pool order, later passes are shuffles. */
function cascadeOrders(n, passes, seed) {
  const next = seededUint32(seed);
  const below = (bound) => {
    // Rejection sampling keeps the shuffle unbiased.
    const limit = 2 ** 32 - (2 ** 32 % bound);
    let x;
    do x = next();
    while (x >= limit);
    return x % bound;
  };
  const orders = [Array.from({ length: n }, (_, i) => i)];
  for (let p = 1; p < passes; p++) {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = below(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    orders.push(order);
  }
  return orders;
}

/** @private XOR prefix sums of `bits` read in `order`: parity of [s, e) is P[e] ^ P[s]. */
function prefixParities(bits, order) {
  const prefix = new Uint8Array(order.length + 1);
  for (let i = 0; i < order.length; i++) prefix[i + 1] = prefix[i] ^ bits[order[i]];
  return prefix;
}

const rangeKey = ([p, s, e]) => `${p}:${s}:${e}`;

/**
 * @private Detector-side Cascade state. `query(ranges)` returns the source's
 * parity of each [pass, start, end) range, in that pass's order.
 */
class CascadeSession {
  constructor(bits, orders, blockSizes, query) {
    this.corrected = [...bits];
    this.orders = orders;
    this.blockSizes = blockSizes;
    this.query = query;
    this.known = new Map();
    this.disclosed = 0;
    this.position = orders.map((order) => {
      const at = new Int32Array(order.length);
      order.forEach((index, pos) => {
        at[index] = pos;
      });
      return at;
    });
  }

  local([p, s, e]) {
    let parity = 0;
    for (let i = s; i < e; i++) parity ^= this.corrected[this.orders[p][i]];
    return parity;
  }

  odd(range) {
    return this.local(range) !== this.known.get(rangeKey(range));
  }

  async ask(ranges) {
    const unique = new Map(ranges.map((r) => [rangeKey(r), r]));
    const missing = [...unique.values()].filter((r) => !this.known.has(rangeKey(r)));
    if (missing.length === 0) return;
    const parities = await this.query(missing);
    this.disclosed += missing.length;
    missing.forEach((r, i) => this.known.set(rangeKey(r), parities[i]));
  }

  blockOf(p, index) {
    const k = this.blockSizes[p];
    const start = Math.floor(this.position[p][index] / k) * k;
    return [p, start, Math.min(start + k, this.corrected.length)];
  }

  // Ranges within one pass are disjoint, so their bisections run in lockstep
  // without one correction changing another range's parity.
  async bisect(ranges) {
    let active = ranges;
    const found = [];
    while (active.length > 0) {
      const halves = active
        .filter(([, s, e]) => e - s > 1)
        .map(([p, s, e]) => [p, s, (s + e) >> 1]);
      await this.ask(halves);
      const next = [];
      for (const [p, s, e] of active) {
        if (e - s === 1) found.push(this.orders[p][s]);
        else next.push(this.half(p, s, e));
      }
      active = next;
    }
    return found;
  }

  /** The half of an odd range that still holds an odd error count. */
  half(p, s, e) {
    const m = (s + e) >> 1;
    const left = this.known.get(rangeKey([p, s, m]));
    // The right half's parity follows from its parent's, so costs no query.
    this.known.set(rangeKey([p, m, e]), this.known.get(rangeKey([p, s, e])) ^ left);
    return this.local([p, s, m]) === left ? [p, m, e] : [p, s, m];
  }

  async runPass(pass) {
    const n = this.corrected.length;
    const k = this.blockSizes[pass];
    const blocks = [];
    for (let s = 0; s < n; s += k) blocks.push([pass, s, Math.min(s + k, n)]);
    await this.ask(blocks);
    const pending = new Map();
    const enqueue = (range) => {
      if (!pending.has(range[0])) pending.set(range[0], new Map());
      pending.get(range[0]).set(rangeKey(range), range);
    };
    blocks.filter((b) => this.odd(b)).forEach(enqueue);
    while (pending.size > 0) {
      const p = Math.min(...pending.keys());
      const group = [...pending.get(p).values()].filter((b) => this.odd(b));
      pending.delete(p);
      for (const index of await this.bisect(group)) this.flip(index, pass, enqueue);
    }
  }

  /** Correct one bit, then re-open every block it sits in from passes so far. */
  flip(index, lastPass, enqueue) {
    this.corrected[index] ^= 1;
    for (let q = 0; q <= lastPass; q++) {
      const block = this.blockOf(q, index);
      if (this.odd(block)) enqueue(block);
    }
  }
}

/** @private Correct `bits` toward the source; returns the bits and parities asked. */
async function cascadeCorrect(bits, orders, blockSizes, query) {
  const session = new CascadeSession(bits, orders, blockSizes, query);
  for (let pass = 0; pass < blockSizes.length; pass++) await session.runPass(pass);
  return { corrected: session.corrected, disclosed: session.disclosed };
}

/** @private parse and bound-check a flat [pass, start, end, ...] query. */
function decodeRanges(flat, n, passes) {
  if (!Array.isArray(flat) || flat.length === 0 || flat.length % 3 !== 0 || flat.length > 3 * n) {
    throw new DistillError('parity query malformed', 'protocol');
  }
  const ranges = [];
  for (let i = 0; i < flat.length; i += 3) {
    const [p, s, e] = flat.slice(i, i + 3);
    const valid =
      [p, s, e].every(Number.isInteger) && p >= 0 && p < passes && s >= 0 && s < e && e <= n;
    if (!valid) throw new DistillError('parity query out of range', 'protocol');
    ranges.push([p, s, e]);
  }
  return ranges;
}

/**
 * Privacy amplification: multiply the corrected key by a random Toeplitz
 * matrix over GF(2) (the leftover-hash construction). The m×n matrix is
 * defined by the shared seed s of length n + m − 1 via T[i][j] = s[i−j+n−1].
 */
export function privacyAmplify(bits, targetLength, seed) {
  const n = bits.length;
  const expected = n + targetLength - 1;
  if (!seed || seed.length !== expected) {
    throw new DistillError(
      `privacy amplification needs a ${expected}-bit Toeplitz seed, got ${seed?.length ?? typeof seed}`,
      'bad-seed',
    );
  }
  const result = new Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    let val = 0;
    for (let j = 0; j < n; j++) {
      if (bits[j]) val ^= seed[i - j + n - 1] & 1;
    }
    result[i] = val;
  }
  return result;
}

/**
 * Source side of a mint. `io` is a typed stream: send(msg), receive(types).
 * The source's pool is the reference; the detector corrects toward it.
 *
 * @param {number[]} pool - accepted sifted bits (consumed by the caller)
 * @param {{send: Function, receive: Function}} io
 * @param {{mintId: number, target?: number, qber?: number}} opts - `qber`
 *   estimates the pool's error rate and sets the Cascade block sizes
 * @returns {Promise<Uint8Array>} the minted key bytes
 */
export async function distillSource(pool, io, { mintId, target = 128, qber = DEFAULT_QBER }) {
  if (!mintable(pool.length, target, qber))
    throw new DistillError('pool below mint budget', 'budget');
  const blockSizes = cascadeBlockSizes(pool.length, qber);
  const permSeed = crypto.getRandomValues(new Uint8Array(PERM_SEED_BYTES));
  await io.send({ type: 'mint-cascade', mintId, blockSizes, permSeed: toB64(permSeed) });
  const prefixes = cascadeOrders(pool.length, blockSizes.length, permSeed).map((order) =>
    prefixParities(pool, order),
  );
  // The source enforces the budget as it answers, so no peer can learn more
  // parities than the key can absorb and still receive a key.
  const allowance = pool.length - VERIFY_HASH_BITS - target;
  let disclosed = 0;
  for (;;) {
    const msg = await expectMint(io, ['mint-parity-query', 'mint-corrected'], mintId);
    if (msg.type === 'mint-corrected') break;
    const ranges = decodeRanges(msg.ranges, pool.length, blockSizes.length);
    disclosed += ranges.length;
    if (disclosed > allowance) {
      await io.send({ type: 'mint-abort', mintId, reason: 'budget' });
      throw new DistillError('reconciliation disclosed more than the key budget', 'budget');
    }
    const parities = ranges.map(([p, s, e]) => prefixes[p][e] ^ prefixes[p][s]);
    await io.send({ type: 'mint-parity-reply', mintId, parities: toB64(packBits(parities)) });
  }
  // Verification: both sides hash their corrected pool; source compares.
  const mine = await verifyHash(pool);
  const theirs = await expectMint(io, ['mint-verify'], mintId);
  const ok = theirs.hash === mine;
  await io.send({ type: 'mint-verdict', mintId, ok });
  if (!ok) throw new DistillError('corrected pools diverge (verification hash mismatch)', 'verify');
  const seed = randomBits(pool.length + target - 1);
  await io.send({ type: 'mint-seed', mintId, seed: toB64(packBits(seed)) });
  return bitsToBytes(privacyAmplify(pool, target, seed));
}

/**
 * Detector side of a mint: run Cascade against the source, verify, amplify.
 * @returns {Promise<Uint8Array>} the minted key bytes
 */
export async function distillDetector(pool, io, { mintId, target = 128 }) {
  const setup = await expectMint(io, ['mint-cascade'], mintId);
  const { blockSizes } = setup;
  const permSeed = fromB64(setup.permSeed);
  const validSizes =
    Array.isArray(blockSizes) &&
    blockSizes.length === CASCADE_PASSES &&
    blockSizes.every((k) => Number.isInteger(k) && k >= 1 && k <= pool.length);
  if (!validSizes || !permSeed || permSeed.length !== PERM_SEED_BYTES) {
    throw new DistillError('cascade setup malformed', 'protocol');
  }
  const orders = cascadeOrders(pool.length, blockSizes.length, permSeed);
  const query = async (ranges) => {
    await io.send({ type: 'mint-parity-query', mintId, ranges: ranges.flat() });
    const reply = await expectMint(io, ['mint-parity-reply', 'mint-abort'], mintId);
    if (reply.type === 'mint-abort') {
      throw new DistillError(`source aborted reconciliation (${reply.reason})`, reply.reason);
    }
    const packed = fromB64(reply.parities);
    if (!packed || packed.length !== Math.ceil(ranges.length / 8)) {
      throw new DistillError('parity reply malformed', 'protocol');
    }
    return unpackBits(packed, ranges.length);
  };
  const { corrected, disclosed } = await cascadeCorrect(pool, orders, blockSizes, query);
  if (pool.length - disclosed - VERIFY_HASH_BITS < target) {
    throw new DistillError('reconciliation disclosed more than the key budget', 'budget');
  }
  await io.send({ type: 'mint-corrected', mintId });
  await io.send({ type: 'mint-verify', mintId, hash: await verifyHash(corrected) });
  const verdict = await expectMint(io, ['mint-verdict'], mintId);
  if (!verdict.ok)
    throw new DistillError('corrected pools diverge (source rejected hash)', 'verify');
  const seedMsg = await expectMint(io, ['mint-seed'], mintId);
  const seedPacked = fromB64(seedMsg.seed);
  const seedLen = corrected.length + target - 1;
  if (!seedPacked || seedPacked.length !== Math.ceil(seedLen / 8)) {
    throw new DistillError('toeplitz seed malformed', 'bad-seed');
  }
  return bitsToBytes(privacyAmplify(corrected, target, unpackBits(seedPacked, seedLen)));
}

/** @private receive one mint message of an expected type, enforcing the mint id. */
async function expectMint(io, types, mintId) {
  const msg = await io.receive(types);
  if (msg.mintId !== mintId) {
    throw new DistillError(`mint id mismatch: expected ${mintId}, got ${msg.mintId}`, 'protocol');
  }
  return msg;
}
