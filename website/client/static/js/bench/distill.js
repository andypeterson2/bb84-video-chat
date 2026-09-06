/**
 * Pooled key distillation: block-parity error correction, verification hash,
 * Toeplitz privacy amplification.
 *
 * Runs once per mint over the accumulated (multi-frame) pool. The math is
 * the round-based protocol's, relocated: one parity bit disclosed per 8-bit
 * block, then the Toeplitz leftover-hash construction. Two additions from
 * the literature and the DTU field system:
 *  - a truncated-hash key-verification exchange after correction (the
 *    epsilon_cor-correctness step of Tomamichel-Lim-Gisin-Renner) — without
 *    it, residual post-correction errors mint divergent keys that only
 *    surface later as opaque GCM decrypt failures;
 *  - the verification hash bits are counted as leaked alongside the
 *    parities (leak_EV in the DTU field trial's key-length accounting).
 */

import { bitsToBytes, packBits, randomBits, toB64, unpackBits, fromB64 } from './packing.js';

/** Error-correction block size — one parity bit is disclosed per block. */
export const PARITY_BLOCK_SIZE = 8;
/** Verification-hash length (bits) — disclosed, so budgeted as leakage. */
export const VERIFY_HASH_BITS = 64;

/** A distillation failure that should fail the mint, not crash the engine. */
export class DistillError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'DistillError';
    this.reason = reason;
  }
}

/** Bits leaked by distilling a pool of `n` bits (parities + verify hash). */
export function leakage(n) {
  return Math.ceil(n / PARITY_BLOCK_SIZE) + VERIFY_HASH_BITS;
}

/** Whether a pool can mint a key of `target` bits after leakage. */
export function mintable(poolLength, target) {
  return poolLength - leakage(poolLength) >= target;
}

/** @private truncated SHA-256 of a bit string, as base64. */
async function verifyHash(bits) {
  const digest = await crypto.subtle.digest('SHA-256', packBits(bits));
  return toB64(new Uint8Array(digest).slice(0, VERIFY_HASH_BITS / 8));
}

/** @private XOR-parities of consecutive blocks. */
function blockParities(bits) {
  const parities = [];
  for (let i = 0; i < bits.length; i += PARITY_BLOCK_SIZE) {
    let p = 0;
    for (let j = i; j < Math.min(i + PARITY_BLOCK_SIZE, bits.length); j++) p ^= bits[j];
    parities.push(p);
  }
  return parities;
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
 * @param {{mintId: number, target?: number}} opts
 * @returns {Promise<Uint8Array>} the minted key bytes
 */
export async function distillSource(pool, io, { mintId, target = 128 }) {
  if (!mintable(pool.length, target)) throw new DistillError('pool below mint budget', 'budget');
  await io.send({ type: 'mint-parities', mintId, parities: toB64(packBits(blockParities(pool))) });
  await expectMint(io, 'mint-corrected', mintId);
  // Verification: both sides hash their corrected pool; source compares.
  const mine = await verifyHash(pool);
  const theirs = await expectMint(io, 'mint-verify', mintId);
  const ok = theirs.hash === mine;
  await io.send({ type: 'mint-verdict', mintId, ok });
  if (!ok) throw new DistillError('corrected pools diverge (verification hash mismatch)', 'verify');
  const seed = randomBits(pool.length + target - 1);
  await io.send({ type: 'mint-seed', mintId, seed: toB64(packBits(seed)) });
  return bitsToBytes(privacyAmplify(pool, target, seed));
}

/**
 * Detector side of a mint: receive parities, correct, verify, amplify.
 * @returns {Promise<Uint8Array>} the minted key bytes
 */
export async function distillDetector(pool, io, { mintId, target = 128 }) {
  if (!mintable(pool.length, target)) throw new DistillError('pool below mint budget', 'budget');
  const parityMsg = await expectMint(io, 'mint-parities', mintId);
  const packed = fromB64(parityMsg.parities);
  const blockCount = Math.ceil(pool.length / PARITY_BLOCK_SIZE);
  if (!packed || packed.length !== Math.ceil(blockCount / 8)) {
    throw new DistillError('parities message malformed', 'protocol');
  }
  const parities = unpackBits(packed, blockCount);
  const corrected = [...pool];
  for (let b = 0; b < blockCount; b++) {
    const start = b * PARITY_BLOCK_SIZE;
    const end = Math.min(start + PARITY_BLOCK_SIZE, corrected.length);
    let p = 0;
    for (let j = start; j < end; j++) p ^= corrected[j];
    // Mismatched block: flip its first bit (single-pass block parity; blocks
    // with an even error count survive — the verification hash catches them).
    if (p !== parities[b]) corrected[start] ^= 1;
  }
  await io.send({ type: 'mint-corrected', mintId });
  await io.send({ type: 'mint-verify', mintId, hash: await verifyHash(corrected) });
  const verdict = await expectMint(io, 'mint-verdict', mintId);
  if (!verdict.ok)
    throw new DistillError('corrected pools diverge (source rejected hash)', 'verify');
  const seedMsg = await expectMint(io, 'mint-seed', mintId);
  const seedPacked = fromB64(seedMsg.seed);
  const seedLen = corrected.length + target - 1;
  if (!seedPacked || seedPacked.length !== Math.ceil(seedLen / 8)) {
    throw new DistillError('toeplitz seed malformed', 'bad-seed');
  }
  return bitsToBytes(privacyAmplify(corrected, target, unpackBits(seedPacked, seedLen)));
}

/** @private receive one mint message, enforcing type AND mint id. */
async function expectMint(io, type, mintId) {
  const msg = await io.receive([type]);
  if (msg.mintId !== mintId) {
    throw new DistillError(`mint id mismatch: expected ${mintId}, got ${msg.mintId}`, 'protocol');
  }
  return msg;
}
