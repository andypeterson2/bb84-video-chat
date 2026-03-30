/**
 * Channel interfaces for BB84 protocol.
 *
 * QuantumChannel: { sendQubits(qubits), receiveQubits() }
 * ClassicalChannel: { send(data), receive() }
 */

/**
 * IdealQuantumChannel — zero noise, in-memory, for tests.
 * Constructor optionally takes a paired instance so Alice and Bob share a buffer.
 */
export class IdealQuantumChannel {
  constructor(peer = null) {
    this._buffer = [];
    this._peer = peer;
    this._resolveWaiter = null;
  }

  setPeer(peer) {
    this._peer = peer;
  }

  async sendQubits(qubits) {
    // Push into the PEER's buffer (Alice sends, Bob receives)
    const target = this._peer;
    if (!target) throw new Error('No peer set on quantum channel');
    target._buffer.push(qubits.map((q) => ({ ...q })));
    if (target._resolveWaiter) {
      target._resolveWaiter();
      target._resolveWaiter = null;
    }
  }

  async receiveQubits() {
    if (this._buffer.length > 0) {
      return this._buffer.shift();
    }
    return new Promise((resolve) => {
      this._resolveWaiter = () => resolve(this._buffer.shift());
    });
  }
}

/**
 * LoopbackClassicalChannel — in-memory message passing between paired instances.
 */
export class LoopbackClassicalChannel {
  constructor(peer = null) {
    this._buffer = [];
    this._peer = peer;
    this._resolveWaiter = null;
  }

  setPeer(peer) {
    this._peer = peer;
  }

  async send(data) {
    const target = this._peer;
    if (!target) throw new Error('No peer set on classical channel');
    const serialized = JSON.parse(JSON.stringify(data));
    target._buffer.push(serialized);
    if (target._resolveWaiter) {
      target._resolveWaiter();
      target._resolveWaiter = null;
    }
  }

  async receive() {
    if (this._buffer.length > 0) {
      return this._buffer.shift();
    }
    return new Promise((resolve) => {
      this._resolveWaiter = () => resolve(this._buffer.shift());
    });
  }
}
