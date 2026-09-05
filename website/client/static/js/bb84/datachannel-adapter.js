/**
 * DataChannel adapters — multiplex quantum and classical BB84 channels
 * over the single 'qkd' WebRTC DataChannel.
 *
 * Message envelope: JSON { ch: 'quantum'|'classical', payload: <data> }
 */

import { SimulatedQuantumChannel } from './simulated.js';

/** A receive cancelled by teardown or a round deadline — NOT peer data. */
export class MuxAbortError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'MuxAbortError';
    this.reason = reason;
  }
}

// Only these logical channels exist; anything else in a message is discarded.
const CHANNEL_NAMES = new Set(['quantum', 'classical', 'control']);
// A peer can flood messages faster than the protocol consumes them; cap the
// backlog so a hostile peer can't grow memory without bound. BB84 rounds
// exchange ~10 classical messages and 1 quantum payload, so 64 is generous.
const MAX_BUFFERED_MESSAGES = 64;
// Wire chunking: an SCTP DataChannel closes outright on messages over the
// negotiated maximum (~256 KB in practice), and one round's simulated-qubit
// payload is bigger than that. Split anything large into ordered chunks well
// under the limit and reassemble on the far side.
const MAX_WIRE_CHARS = 60 * 1024;
// Reassembly caps (per hostile peer): bounded chunk count and one partial at
// a time — the channel is ordered and reliable, so interleaving means abuse.
const MAX_CHUNKS = 32;

/**
 * Multiplexes a single DataChannel into named logical channels.
 * Uses the same buffer + resolveWaiter pattern as channel.js.
 */
export class DataChannelMux {
  /**
   * @param {function(string): void} sendFn - sends a string over the DataChannel
   */
  constructor(sendFn) {
    this._sendFn = sendFn;
    this._queues = {};
    this._chunkId = 0;
    this._partial = null; // { id, total, parts: string[] }
    this._closed = false;
  }

  /**
   * Tear the mux down: every pending receive rejects with MuxAbortError and
   * all future receives reject immediately. Without this, a waiter parked on
   * a channel the peer will never write again is suspended forever — pinning
   * the round, the orchestrator, and everything their closures reference.
   */
  close() {
    this._closed = true;
    for (const q of Object.values(this._queues)) {
      const waiters = q.waiters.splice(0);
      for (const w of waiters) {
        w.cleanup?.();
        w.reject(new MuxAbortError('mux closed', 'destroyed'));
      }
    }
  }

  /**
   * Drop buffered-but-unread quantum/classical messages (waiters are kept).
   *
   * The DataChannel is ordered, so a control message (round-start) delimits
   * rounds: any data message still buffered when one arrives predates the
   * round being announced and would poison it — a stale qubit payload shifts
   * every positional read one round behind, and the desync never heals. The
   * initiator flushes its own side the same way before announcing.
   */
  flushDataBuffers() {
    for (const name of ['quantum', 'classical']) {
      if (this._queues[name]) this._queues[name].buffer.length = 0;
    }
  }

  /**
   * Send a payload on a named channel (chunked when the wire form is large).
   * @param {string} channelName
   * @param {*} payload
   */
  send(channelName, payload) {
    const wire = JSON.stringify({ ch: channelName, payload });
    if (wire.length <= MAX_WIRE_CHARS) {
      this._sendFn(wire);
      return;
    }
    const total = Math.ceil(wire.length / MAX_WIRE_CHARS);
    if (total > MAX_CHUNKS) {
      throw new Error(`Mux payload too large: ${wire.length} chars`);
    }
    const id = this._chunkId++;
    for (let i = 0; i < total; i++) {
      this._sendFn(
        JSON.stringify({
          chunk: { id, index: i, total },
          data: wire.slice(i * MAX_WIRE_CHARS, (i + 1) * MAX_WIRE_CHARS),
        }),
      );
    }
  }

  /**
   * Receive the next message on a named channel (async, queued).
   *
   * An optional AbortSignal bounds the wait: aborting rejects the promise
   * with MuxAbortError instead of leaving it suspended forever. Every
   * protocol read runs under the orchestrator's per-round deadline signal,
   * so a peer that goes silent (crash, one-sided abort, dropped message)
   * converges on a failed round rather than a permanent hang.
   *
   * @param {string} channelName
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<*>}
   */
  receive(channelName, { signal } = {}) {
    if (this._closed) {
      return Promise.reject(new MuxAbortError('mux closed', 'destroyed'));
    }
    const q = this._getQueue(channelName);
    if (q.buffer.length > 0) {
      return Promise.resolve(q.buffer.shift());
    }
    if (signal?.aborted) {
      return Promise.reject(new MuxAbortError('receive aborted', signal.reason));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, cleanup: null };
      if (signal) {
        const onAbort = () => {
          const i = q.waiters.indexOf(waiter);
          if (i >= 0) q.waiters.splice(i, 1);
          reject(new MuxAbortError('receive aborted', signal.reason));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      q.waiters.push(waiter);
    });
  }

  /**
   * Route an incoming DataChannel message to the correct queue.
   *
   * Hardened against a hostile peer: malformed JSON and unknown channel
   * names are dropped (the typed-message layer in protocol.js turns any
   * resulting gap into a clean protocol-error abort), and per-channel
   * buffers are capped so a flood can't grow memory without bound.
   *
   * @param {string} raw - raw JSON string from the DataChannel
   * @param {boolean} [fromChunks] - set when raw was reassembled from chunks;
   *   a reassembled message may not itself be a chunk envelope (recursion guard)
   */
  handleMessage(raw, fromChunks = false) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.chunk !== undefined) {
      if (!fromChunks) this._handleChunk(msg);
      return;
    }
    if (!CHANNEL_NAMES.has(msg.ch)) return;
    if (msg.ch === 'control') this.flushDataBuffers();
    const q = this._getQueue(msg.ch);
    if (q.waiters.length > 0) {
      const waiter = q.waiters.shift();
      waiter.cleanup?.();
      waiter.resolve(msg.payload);
    } else if (q.buffer.length < MAX_BUFFERED_MESSAGES) {
      q.buffer.push(msg.payload);
    }
    // Over the cap: drop. Starving the protocol is a self-inflicted abort.
  }

  /**
   * Reassemble a chunked message. The DataChannel is ordered and reliable, so
   * chunks of one message arrive contiguously; anything out of sequence, over
   * the caps, or malformed drops the partial (the typed-message layer above
   * turns the resulting gap into a clean protocol-error abort).
   * @private
   */
  _handleChunk(msg) {
    const c = msg.chunk;
    if (
      !c ||
      typeof msg.data !== 'string' ||
      msg.data.length > MAX_WIRE_CHARS ||
      !Number.isInteger(c.id) ||
      !Number.isInteger(c.index) ||
      !Number.isInteger(c.total) ||
      c.total < 1 ||
      c.total > MAX_CHUNKS ||
      c.index < 0 ||
      c.index >= c.total
    ) {
      this._partial = null;
      return;
    }
    if (c.index === 0) {
      this._partial = { id: c.id, total: c.total, parts: [msg.data] };
    } else if (
      this._partial &&
      this._partial.id === c.id &&
      this._partial.total === c.total &&
      this._partial.parts.length === c.index
    ) {
      this._partial.parts.push(msg.data);
    } else {
      this._partial = null;
      return;
    }
    if (this._partial.parts.length === this._partial.total) {
      const wire = this._partial.parts.join('');
      this._partial = null;
      this.handleMessage(wire, true);
    }
  }

  /** @private */
  _getQueue(name) {
    if (!this._queues[name]) {
      this._queues[name] = { buffer: [], waiters: [] };
    }
    return this._queues[name];
  }
}

/**
 * QuantumChannel adapter for Alice — runs SimulatedQuantumChannel locally,
 * then sends the simulated output over the DataChannel to Bob.
 */
export class AliceQuantumChannel {
  /**
   * @param {DataChannelMux} mux
   * @param {object} [simOptions] - options for SimulatedQuantumChannel
   * @param {AbortSignal} [signal] - per-round deadline/teardown signal
   */
  constructor(mux, simOptions = {}, signal = undefined) {
    this._mux = mux;
    this._signal = signal;
    this._sim = new SimulatedQuantumChannel(simOptions);
    this._receiver = this._sim.createReceiver();
  }

  /** Toggle eavesdropper on the simulated channel. */
  setEavesdropper(enabled) {
    this._sim.setEavesdropper(enabled);
  }

  /**
   * Simulate qubit transmission locally, then send results to Bob.
   * @param {Array<{bit: number, basis: number}>} qubits
   */
  async sendQubits(qubits) {
    await this._sim.sendQubits(qubits);
    const simulated = await this._receiver.receiveQubits();
    this._mux.send('quantum', simulated);
  }

  async receiveQubits() {
    return this._mux.receive('quantum', { signal: this._signal });
  }
}

/**
 * QuantumChannel adapter for Bob — receives simulated qubits from Alice
 * over the DataChannel.
 */
export class BobQuantumChannel {
  /**
   * @param {DataChannelMux} mux
   * @param {AbortSignal} [signal] - per-round deadline/teardown signal
   */
  constructor(mux, signal = undefined) {
    this._mux = mux;
    this._signal = signal;
  }

  async sendQubits(qubits) {
    this._mux.send('quantum', qubits);
  }

  /** @returns {Promise<Array<{bit: number, basis: number, detected: boolean}>>} */
  async receiveQubits() {
    return this._mux.receive('quantum', { signal: this._signal });
  }
}

/**
 * ClassicalChannel adapter — wraps the mux's 'classical' channel.
 */
export class DataChannelClassicalChannel {
  /**
   * @param {DataChannelMux} mux
   * @param {AbortSignal} [signal] - per-round deadline/teardown signal
   */
  constructor(mux, signal = undefined) {
    this._mux = mux;
    this._signal = signal;
  }

  async send(data) {
    this._mux.send('classical', data);
  }

  async receive() {
    return this._mux.receive('classical', { signal: this._signal });
  }
}
