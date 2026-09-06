/**
 * DaemonFrameSource — a FrameSource backed by a local hardware-bench daemon.
 *
 * In optical mode each browser talks to its OWN daemon over a paired,
 * loopback WebSocket: the source browser's daemon fires pulses down the real
 * fiber to the detector browser's daemon, which recovers detections and
 * pushes them to its browser. So — unlike loopback, where the source browser
 * computes detections and ships them to the peer over the mux — detections
 * reach the detector browser from its own daemon, and the classical
 * reconciliation still rides the peers' authenticated DataChannel.
 *
 * The WebSocket is injectable (a factory) so tests drive a fake transport.
 */

import { packBits, unpackBits, encodeIndices, decodeIndices, toB64, fromB64 } from './packing.js';

const PROTO_V = 1;

/** A daemon connection: pairing, role discovery, and message routing. */
export class DaemonConnection {
  /**
   * @param {object} options
   * @param {string} options.url - ws:// endpoint of the local daemon
   * @param {string} options.token - one-time pairing token (from daemon stdout)
   * @param {function(string): WebSocket} [options.wsFactory] - test seam
   */
  constructor({ url, token, wsFactory }) {
    this._url = url;
    this._token = token;
    this._wsFactory = wsFactory ?? ((u) => new WebSocket(u));
    this._ws = null;
    this._role = null;
    this._pairResolve = null;
    this._pairReject = null;
    this._sentResolvers = new Map(); // frameId -> resolve(frame-sent)
    this._onDetections = null;
    this._onStatus = null;
    this._onClose = null;
    this._closed = false;
  }

  get role() {
    return this._role;
  }

  /** Open the socket and pair; resolves once the daemon reports its role. */
  connect({ signal } = {}) {
    return new Promise((resolve, reject) => {
      this._pairResolve = resolve;
      this._pairReject = reject;
      let ws;
      try {
        ws = this._wsFactory(this._url);
      } catch (err) {
        reject(err);
        return;
      }
      this._ws = ws;
      if (signal) {
        signal.addEventListener('abort', () => this.close(), { once: true });
      }
      ws.onopen = () => ws.send(JSON.stringify({ t: 'pair', token: this._token, v: PROTO_V }));
      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onerror = () => this._failPairing(new Error('daemon socket error'));
      ws.onclose = () => {
        this._failPairing(new Error('daemon socket closed before pairing'));
        if (!this._closed) this._onClose?.();
        this._closed = true;
      };
    });
  }

  _failPairing(err) {
    if (this._pairReject) {
      this._pairReject(err);
      this._pairReject = null;
      this._pairResolve = null;
    }
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'paired':
        this._role = msg.role;
        if (this._pairResolve) {
          this._pairResolve(msg);
          this._pairResolve = null;
          this._pairReject = null;
        }
        break;
      case 'refused':
        this._failPairing(new Error(`daemon refused pairing: ${msg.reason}`));
        break;
      case 'frame-sent': {
        const r = this._sentResolvers.get(msg.frame_id);
        if (r) {
          this._sentResolvers.delete(msg.frame_id);
          r(msg);
        }
        break;
      }
      case 'detections':
        this._onDetections?.(decodeDaemonDetections(msg));
        break;
      case 'status':
        this._onStatus?.(msg);
        break;
      default:
        break;
    }
  }

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  async startAcquisition() {
    this._send({ t: 'start' });
  }

  async stopAcquisition() {
    this._send({ t: 'stop' });
  }

  /** Source role: fire one frame; resolves on the daemon's frame-sent. */
  transmit(frameId, bits, bases) {
    this._send({
      t: 'transmit',
      frame_id: frameId,
      slots: bits.length,
      bits: toB64(packBits(bits)),
      bases: toB64(packBits(bases)),
    });
    return new Promise((resolve) => this._sentResolvers.set(frameId, resolve));
  }

  setEavesdropper(enabled) {
    this._send({ t: 'eve', enabled: !!enabled });
  }

  onDetections(cb) {
    this._onDetections = cb;
  }

  onStatus(cb) {
    this._onStatus = cb;
  }

  onClose(cb) {
    this._onClose = cb;
  }

  close() {
    this._closed = true;
    try {
      this._ws?.close();
    } catch {
      /* already closing */
    }
  }
}

/** Decode a daemon `detections` message into the engine's detection shape. */
export function decodeDaemonDetections(msg) {
  const indices = decodeIndices(fromB64(msg.indices));
  const count = indices.length;
  return {
    frameId: msg.frame_id,
    indices,
    bits: unpackBits(fromB64(msg.bits), count),
    bases: unpackBits(fromB64(msg.bases), count),
    stats: msg.stats ?? {},
  };
}

/**
 * The FrameSource the reservoir engine drives, backed by a live
 * DaemonConnection. Source role transmits; detector role surfaces the
 * daemon's detections. The mux is unused (the fiber carries the quantum
 * part daemon-to-daemon).
 */
export class DaemonFrameSource {
  /** @param {DaemonConnection} conn - an already-connected daemon */
  constructor(conn) {
    this.role = conn.role;
    this._conn = conn;
  }

  async connect() {
    // The connection was opened by app.js before negotiation (to learn the
    // role); nothing to do here.
  }

  async start() {
    await this._conn.startAcquisition();
  }

  async stop() {
    await this._conn.stopAcquisition();
  }

  async transmit(frame) {
    if (this.role !== 'source') throw new Error('transmit is a source-role operation');
    await this._conn.transmit(frame.frameId, frame.bits, frame.bases);
  }

  setEavesdropper(enabled) {
    if (this.role !== 'source') throw new Error('only the source role owns the eavesdropper');
    this._conn.setEavesdropper(enabled);
  }

  onDetections(cb) {
    this._conn.onDetections(cb);
  }

  onStatus(cb) {
    this._conn.onStatus(cb);
  }
}

export { packBits, unpackBits, encodeIndices, decodeIndices };
