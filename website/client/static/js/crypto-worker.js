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
 *   - out: { type: 'metrics', encryptLatencyUs / decryptLatencyUs }
 *   - out: { type: 'decrypt-error' }
 */

let currentKey = null;
let currentKeyIndex = 0;
let announcedKeyless = false;

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
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, currentKey, frame.data);

  const result = new Uint8Array(2 + 12 + ciphertext.byteLength);
  result[0] = currentKeyIndex & 0xff;
  result[1] = (currentKeyIndex >> 8) & 0xff;
  result.set(iv, 2);
  result.set(new Uint8Array(ciphertext), 14);
  frame.data = result.buffer;

  const latencyUs = (performance.now() - t0) * 1000;
  self.postMessage({ type: 'metrics', encryptLatencyUs: latencyUs });

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

  const iv = view.slice(2, 14);
  const ciphertext = view.slice(14);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, currentKey, ciphertext);
    frame.data = plaintext;

    const latencyUs = (performance.now() - t0) * 1000;
    self.postMessage({ type: 'metrics', decryptLatencyUs: latencyUs });

    controller.enqueue(frame);
  } catch {
    // Decryption failed — drop the frame (GCM auth tag mismatch)
    self.postMessage({ type: 'decrypt-error' });
  }
}

/* ── Message handler (key updates from main thread) ────────────── */

self.onmessage = async (event) => {
  const { type, rawKey, keyIndex } = event.data;
  if (type === 'set-key') {
    currentKey = await importKey(rawKey);
    currentKeyIndex = keyIndex;
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
