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

// Key ring: the current key plus its predecessor, selected per-frame by the
// keyIndex the sender wrote into the frame header. During a re-key the two
// sides never switch on the same frame; with a single key slot every frame
// sent under the other epoch failed auth and the video froze at each re-key.
const KEY_RING_SIZE = 2;
const keyRing = new Map(); // keyIndex -> CryptoKey
let currentKey = null;
let currentKeyIndex = 0;
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

/**
 * Import a raw AES-128-GCM key.
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
async function importKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
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
 * Frame format: [keyIndex:2][iv:12][ciphertext+tag]
 */
async function encryptFrame(frame, controller) {
  if (!currentKey) {
    dropKeyless();
    return; // fail closed: no key, no frame
  }

  const t0 = performance.now();
  // Random 96-bit IV per frame. AES-GCM's random-IV birthday bound (a nonce
  // collision becomes non-negligible near ~2^32 frames under one key) is kept
  // far out of reach by key rotation: the reservoir mints a fresh key on a
  // ~10s floor (ROTATION_FLOOR_MS in reservoir.js), so frames-per-key stays in
  // the thousands. If that cadence is ever raised toward 2^32 frames/key,
  // switch to a deterministic counter IV before doing so.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, currentKey, frame.data);

  const result = new Uint8Array(2 + 12 + ciphertext.byteLength);
  result[0] = currentKeyIndex & 0xff;
  result[1] = (currentKeyIndex >> 8) & 0xff;
  result.set(iv, 2);
  result.set(new Uint8Array(ciphertext), 14);
  frame.data = result.buffer;

  stats.encryptFrames++;
  stats.encryptLatencyTotalUs += (performance.now() - t0) * 1000;
  maybeReport();

  controller.enqueue(frame);
}

/**
 * Decrypt an encoded frame.
 */
async function decryptFrame(frame, controller) {
  if (!currentKey) {
    dropKeyless();
    return; // fail closed: cannot authenticate, do not render
  }

  const t0 = performance.now();
  const view = new Uint8Array(frame.data);

  if (view.length < 14) {
    // Too small to carry [keyIndex:2][iv:12] — not one of our frames. Drop it;
    // passing it through would render unauthenticated data.
    return;
  }

  // Select the key the SENDER used (header keyIndex), not whatever this side
  // installed last — the two sides never re-key on the same frame boundary.
  const frameKeyIndex = view[0] | (view[1] << 8);
  const key = keyRing.get(frameKeyIndex);
  if (!key) {
    // Outside the ring: either far ahead (we missed a re-key) or long stale.
    noteDecryptFailure();
    return;
  }

  const iv = view.slice(2, 14);
  const ciphertext = view.slice(14);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    frame.data = plaintext;

    stats.decryptFrames++;
    stats.decryptLatencyTotalUs += (performance.now() - t0) * 1000;
    maybeReport();

    controller.enqueue(frame);
  } catch {
    // Decryption failed — drop the frame (GCM auth tag mismatch)
    noteDecryptFailure();
  }
}

/* ── Message handler (key updates from main thread) ────────────── */

self.onmessage = async (event) => {
  const { type, rawKey, keyIndex } = event.data;
  if (type === 'set-key') {
    currentKey = await importKey(rawKey);
    currentKeyIndex = keyIndex;
    keyRing.set(keyIndex, currentKey);
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
