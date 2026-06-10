/**
 * DataChannel adapters — multiplex quantum and classical BB84 channels
 * over the single 'qkd' WebRTC DataChannel.
 *
 * Message envelope: JSON { ch: 'quantum'|'classical', payload: <data> }
 */

import { SimulatedQuantumChannel } from './simulated.js';

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
  }

  /**
   * Send a payload on a named channel.
   * @param {string} channelName
   * @param {*} payload
   */
  send(channelName, payload) {
    this._sendFn(JSON.stringify({ ch: channelName, payload }));
  }

  /**
   * Receive the next message on a named channel (async, queued).
   * @param {string} channelName
   * @returns {Promise<*>}
   */
  receive(channelName) {
    const q = this._getQueue(channelName);
    if (q.buffer.length > 0) {
      return Promise.resolve(q.buffer.shift());
    }
    return new Promise((resolve) => {
      q.waiters.push(resolve);
    });
  }

  /**
   * Route an incoming DataChannel message to the correct queue.
   * @param {string} raw - raw JSON string from the DataChannel
   */
  handleMessage(raw) {
    const msg = JSON.parse(raw);
    const q = this._getQueue(msg.ch);
    if (q.waiters.length > 0) {
      q.waiters.shift()(msg.payload);
    } else {
      q.buffer.push(msg.payload);
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
   */
  constructor(mux, simOptions = {}) {
    this._mux = mux;
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
    return this._mux.receive('quantum');
  }
}

/**
 * QuantumChannel adapter for Bob — receives simulated qubits from Alice
 * over the DataChannel.
 */
export class BobQuantumChannel {
  /** @param {DataChannelMux} mux */
  constructor(mux) {
    this._mux = mux;
  }

  async sendQubits(qubits) {
    this._mux.send('quantum', qubits);
  }

  /** @returns {Promise<Array<{bit: number, basis: number, detected: boolean}>>} */
  async receiveQubits() {
    return this._mux.receive('quantum');
  }
}

/**
 * ClassicalChannel adapter — wraps the mux's 'classical' channel.
 */
export class DataChannelClassicalChannel {
  /** @param {DataChannelMux} mux */
  constructor(mux) {
    this._mux = mux;
  }

  async send(data) {
    this._mux.send('classical', data);
  }

  async receive() {
    return this._mux.receive('classical');
  }
}
