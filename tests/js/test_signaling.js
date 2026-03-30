/**
 * Tests for SignalingClient — the browser-side Socket.IO signaling wrapper.
 */

// Mock Socket.IO — we test signaling logic, not the transport
class MockSocket {
  constructor() {
    this._handlers = {};
    this.emitted = [];
    this.connected = false;
    this.id = 'mock-sid-1';
  }
  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(handler);
  }
  off(event, handler) {
    if (this._handlers[event]) {
      this._handlers[event] = this._handlers[event].filter((h) => h !== handler);
    }
  }
  emit(event, data) {
    this.emitted.push({ event, data });
  }
  disconnect() {
    this.connected = false;
    this._fire('disconnect');
  }
  // Test helper: simulate server sending an event
  _fire(event, data) {
    const cbs = this._handlers[event] || [];
    cbs.forEach((cb) => cb(data));
  }
  // Test helper: simulate connection
  _simulateConnect() {
    this.connected = true;
    this._fire('connect');
  }
}

// We import the module under test dynamically since it uses export
let SignalingClient;

beforeEach(async () => {
  // Re-import to get a fresh module
  const mod = await import('../../website/client/static/js/signaling.js');
  SignalingClient = mod.SignalingClient;
});

describe('SignalingClient', () => {
  let socket;
  let client;

  beforeEach(() => {
    socket = new MockSocket();
    client = new SignalingClient(socket);
  });

  test('createRoom emits create_room event', () => {
    client.createRoom();
    expect(socket.emitted).toEqual([{ event: 'create_room', data: undefined }]);
  });

  test('joinRoom emits join_room with room_id', () => {
    client.joinRoom('ABC12');
    expect(socket.emitted).toEqual([{ event: 'join_room', data: { room_id: 'ABC12' } }]);
  });

  test('leave emits leave_room', () => {
    client.leave();
    expect(socket.emitted).toEqual([{ event: 'leave_room', data: undefined }]);
  });

  test('sendOffer emits offer with sdp', () => {
    client.sendOffer({ type: 'offer', sdp: 'test-sdp' });
    expect(socket.emitted[0].event).toBe('offer');
    expect(socket.emitted[0].data.sdp.sdp).toBe('test-sdp');
  });

  test('sendAnswer emits answer with sdp', () => {
    client.sendAnswer({ type: 'answer', sdp: 'test-sdp' });
    expect(socket.emitted[0].event).toBe('answer');
  });

  test('sendIceCandidate emits ice_candidate', () => {
    client.sendIceCandidate({ candidate: 'test-candidate' });
    expect(socket.emitted[0].event).toBe('ice_candidate');
  });

  test('welcome event fires callback with sid', () => {
    const received = [];
    client.on('welcome', (data) => received.push(data));
    socket._fire('welcome', { sid: 'abc' });
    expect(received).toEqual([{ sid: 'abc' }]);
  });

  test('room-created event fires callback with room_id', () => {
    const received = [];
    client.on('room-created', (data) => received.push(data));
    socket._fire('room-created', { room_id: 'XYZ99' });
    expect(received).toEqual([{ room_id: 'XYZ99' }]);
  });

  test('room-joined event fires callback with initiator flag', () => {
    const received = [];
    client.on('room-joined', (data) => received.push(data));
    socket._fire('room-joined', { room_id: 'XYZ99', initiator: true });
    expect(received[0].initiator).toBe(true);
  });

  test('peer-disconnected event fires callback', () => {
    const received = [];
    client.on('peer-disconnected', (data) => received.push(data));
    socket._fire('peer-disconnected', { room_id: 'XYZ99' });
    expect(received.length).toBe(1);
  });

  test('error event fires callback', () => {
    const received = [];
    client.on('error', (data) => received.push(data));
    socket._fire('error', { message: 'Cannot join room' });
    expect(received[0].message).toBe('Cannot join room');
  });

  test('offer/answer/ice-candidate relay events fire callbacks', () => {
    const offers = [], answers = [], ice = [];
    client.on('offer', (d) => offers.push(d));
    client.on('answer', (d) => answers.push(d));
    client.on('ice-candidate', (d) => ice.push(d));

    socket._fire('offer', { sdp: 'remote-offer', from: 'sid2' });
    socket._fire('answer', { sdp: 'remote-answer', from: 'sid2' });
    socket._fire('ice-candidate', { candidate: 'cand1', from: 'sid2' });

    expect(offers.length).toBe(1);
    expect(answers.length).toBe(1);
    expect(ice.length).toBe(1);
  });

  test('off() removes a listener', () => {
    const received = [];
    const handler = (data) => received.push(data);
    client.on('welcome', handler);
    client.off('welcome', handler);
    socket._fire('welcome', { sid: 'abc' });
    expect(received.length).toBe(0);
  });

  test('disconnect event fires callback', () => {
    const received = [];
    client.on('disconnect', () => received.push(true));
    socket._fire('disconnect');
    expect(received.length).toBe(1);
  });
});
