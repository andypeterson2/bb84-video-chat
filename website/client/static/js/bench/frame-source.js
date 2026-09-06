/**
 * FrameSource — the one contract every quantum backend implements.
 *
 * A frame source is a bench: the loopback source runs the in-browser
 * simulator, the daemon source drives a hardware bench daemon over a local
 * WebSocket, and a future real bench is the daemon source with vendor
 * drivers underneath. The reservoir engine is written against this contract
 * only, which is what makes the backends swappable.
 *
 * Contract (documented here; enforced by the engine's usage and the shared
 * test suite in tests/js/bench/):
 *
 *   role: 'source' | 'detector'
 *     The physics role — which side owns the photon source. Independent of
 *     the call's initiator role (who announces/orchestrates).
 *
 *   async connect({ signal }) → void
 *     Reach the backend (pairing/handshake). Throws on refusal. The loopback
 *     source resolves immediately.
 *
 *   async start(config) / async stop()
 *     Begin/end streaming. `config` carries { slotsPerFrame }.
 *
 *   async transmit(frame)                       [source role only]
 *     frame = { frameId, bits: Uint8Array, bases: Uint8Array } (unpacked
 *     0/1 per slot). Fire the frame down the bench.
 *
 *   setEavesdropper(enabled)                    [source role only]
 *     Route the demo Eve toggle to wherever the tap lives.
 *
 *   onDetections(cb)                            [detector role only]
 *     cb({ frameId, indices: Uint32Array, bits: Uint8Array,
 *          bases: Uint8Array, stats }) — sparse detection set for one frame,
 *     ascending slot order; bits/bases are per-detection.
 *
 *   onStatus(cb)
 *     Telemetry: { detections, slots, ... } — shape is backend-specific and
 *     display-only; the engine never branches on it.
 */

/** Slots per loopback frame — matches the old per-round pulse count. */
export const DEFAULT_SLOTS_PER_FRAME = 8192;
