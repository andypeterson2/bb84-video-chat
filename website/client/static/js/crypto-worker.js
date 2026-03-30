/**
 * Crypto Worker for Insertable Streams.
 *
 * Runs in a Web Worker context. Receives RTCRtpScriptTransform events
 * and encrypts/decrypts encoded frames using AES-128-GCM.
 *
 * Communication with main thread:
 *   - { type: 'set-key', rawKey: Uint8Array, keyIndex: number }
 *   - { type: 'metrics', encryptLatencyUs: number, decryptLatencyUs: number }
 */

let currentKey = null;
let currentKeyIndex = 0;

/**
 * Import a raw AES-128-GCM key.
 * @param {Uint8Array} rawKey
 * @returns {Promise<CryptoKey>}
 */
async function importKey(rawKey) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt an encoded frame.
 * Frame format: [keyIndex:2][iv:12][ciphertext+tag]
 */
async function encryptFrame(frame, controller) {
  if (!currentKey) {
    // Pass through unencrypted if no key is set
    controller.enqueue(frame);
    return;
  }

  const t0 = performance.now();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    currentKey,
    frame.data,
  );

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
    controller.enqueue(frame);
    return;
  }

  const t0 = performance.now();
  const view = new Uint8Array(frame.data);

  if (view.length < 14) {
    // Too small to be encrypted — pass through
    controller.enqueue(frame);
    return;
  }

  const iv = view.slice(2, 14);
  const ciphertext = view.slice(14);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      currentKey,
      ciphertext,
    );
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
    event.transformer.readable
      .pipeThrough(transform)
      .pipeTo(event.transformer.writable);
  });
}
