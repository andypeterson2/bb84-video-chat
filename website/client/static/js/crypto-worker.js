/**
 * Crypto Worker for Insertable Streams.
 *
 * Runs in a Web Worker context. Receives RTCRtpScriptTransform events
 * and encrypts/decrypts encoded frames using AES-128-GCM.
 *
 * FAIL-CLOSED: until a key arrives, every frame is DROPPED — never passed
 * through in the clear. The pre-key media blackout is the honest behavior;
 * the UI's cipher-state pill (fed by the messages below) tells the user why.
 *
 * Communication with main thread:
 *   - in:  { type: 'set-key', rawKey: Uint8Array, keyIndex: number }
 *   - out: { type: 'cipher-state', state: 'keyless'|'encrypting', keyIndex? }
 *   - out: { type: 'metrics', ...aggregated counters, at most one per second }
 *   - out: { type: 'decrypt-error', failures } (debounced, at most one per second)
 */

// SFrame-aligned framing (RFC 9605): the shared crypto.js module derives a
// per-epoch AES-GCM key + salt, seals each frame under a salt-XOR-counter nonce
// with the header bound as AAD, and opens frames by the KID in that header. The
// worker owns only the epoch ring, the send counter, and the fail-closed policy.
import { deriveEpoch, sealFrame, openFrame } from './crypto.js';

// Key ring: the current epoch plus its predecessor, selected per-frame by the
// KID the sender wrote into the header. During a re-key the two sides never
// switch on the same frame; with a single slot every frame under the other
// epoch failed auth and the video froze at each re-key.
const KEY_RING_SIZE = 2;
const keyRing = new Map(); // KID -> { key: CryptoKey, salt: Uint8Array(12) }
let currentEpoch = null; // { key, salt } for currentKeyIndex
let currentKeyIndex = 0;
let sendCtr = 0; // per-epoch monotonic frame counter (reset on each new epoch)
let announcedKeyless = false;

// Per-frame postMessage fanout (2 messages per frame at 30-60 fps per
// direction) measurably loads the main thread; aggregate and report 1/s.
const REPORT_INTERVAL_MS = 1000;
const stats = {
  encryptFrames: 0,
  encryptLatencyTotalUs: 0,
  decryptFrames: 0,
  decryptLatencyTotalUs: 0,
  decryptFailures: 0,
};
let lastReportAt = 0;
let lastErrorAt = -Infinity;

function maybeReport() {
  const now = performance.now();
  if (now - lastReportAt < REPORT_INTERVAL_MS) return;
  lastReportAt = now;
  self.postMessage({
    type: 'metrics',
    encryptFrames: stats.encryptFrames,
    decryptFrames: stats.decryptFrames,
    encryptLatencyUs: stats.encryptFrames ? stats.encryptLatencyTotalUs / stats.encryptFrames : 0,
    decryptLatencyUs: stats.decryptFrames ? stats.decryptLatencyTotalUs / stats.decryptFrames : 0,
    decryptFailures: stats.decryptFailures,
  });
  stats.encryptFrames = 0;
  stats.encryptLatencyTotalUs = 0;
  stats.decryptFrames = 0;
  stats.decryptLatencyTotalUs = 0;
  stats.decryptFailures = 0;
}

function noteDecryptFailure() {
  stats.decryptFailures++;
  const now = performance.now();
  if (now - lastErrorAt >= REPORT_INTERVAL_MS) {
    lastErrorAt = now;
    self.postMessage({ type: 'decrypt-error', failures: stats.decryptFailures });
  }
}

/** Drop a keyless frame, announcing the state once (not per frame). */
function dropKeyless() {
  if (!announcedKeyless) {
    announcedKeyless = true;
    self.postMessage({ type: 'cipher-state', state: 'keyless' });
  }
}

/**
 * Encrypt an encoded frame.
 * Frame format: [SFrame header][ciphertext+tag], nonce = salt XOR CTR, the
 * header bound as AES-GCM additional authenticated data.
 */
async function encryptFrame(frame, controller) {
  if (!currentEpoch) {
    dropKeyless();
    return; // fail closed: no key, no frame
  }

  const t0 = performance.now();
  frame.data = await sealFrame(frame.data, currentEpoch, {
    kid: currentKeyIndex,
    ctr: sendCtr++,
    isKey: frame.type === 'key',
  });

  stats.encryptFrames++;
  stats.encryptLatencyTotalUs += (performance.now() - t0) * 1000;
  maybeReport();

  controller.enqueue(frame);
}

/**
 * Decrypt an encoded frame.
 */
async function decryptFrame(frame, controller) {
  if (keyRing.size === 0) {
    dropKeyless();
    return; // fail closed: cannot authenticate, do not render
  }

  const t0 = performance.now();

  // Open selects the epoch by the KID the SENDER wrote into the header (the two
  // sides never re-key on the same frame boundary). null = malformed header,
  // drop silently; a throw = unknown KID or GCM auth/AAD mismatch, count it.
  let opened;
  try {
    opened = await openFrame(frame.data, (kid) => keyRing.get(kid));
  } catch {
    noteDecryptFailure();
    return;
  }
  if (!opened) return;
  frame.data = opened.plaintext;

  stats.decryptFrames++;
  stats.decryptLatencyTotalUs += (performance.now() - t0) * 1000;
  maybeReport();

  controller.enqueue(frame);
}

/* ── Message handler (key updates from main thread) ────────────── */

self.onmessage = async (event) => {
  const { type, rawKey, keyIndex } = event.data;
  if (type === 'set-key') {
    const epoch = await deriveEpoch(rawKey);
    currentEpoch = epoch;
    currentKeyIndex = keyIndex;
    // Fresh counter space for the new epoch: its salt is independent, so a CTR
    // restarting at 0 still keeps every (key, salt, CTR) triple unique.
    sendCtr = 0;
    keyRing.set(keyIndex, epoch);
    // Keep only the newest KEY_RING_SIZE epochs (Map preserves insert order).
    for (const idx of keyRing.keys()) {
      if (keyRing.size <= KEY_RING_SIZE) break;
      keyRing.delete(idx);
    }
    announcedKeyless = false;
    self.postMessage({ type: 'cipher-state', state: 'encrypting', keyIndex });
  }
};

/* ── Insertable Streams handler ────────────────────────────────── */

if (typeof self.RTCTransformEvent !== 'undefined' || typeof self.onrtctransform !== 'undefined') {
  self.addEventListener('rtctransform', (event) => {
    const { operation } = event.transformer.options;
    const transform = new TransformStream({
      async transform(frame, controller) {
        if (operation === 'encrypt') {
          await encryptFrame(frame, controller);
        } else {
          await decryptFrame(frame, controller);
        }
      },
    });
    event.transformer.readable.pipeThrough(transform).pipeTo(event.transformer.writable);
  });
}
