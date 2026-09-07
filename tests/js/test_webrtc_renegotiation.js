/**
 * Renegotiation guard — an offer arriving mid-call must NOT rebuild the peer
 * connection. A rebuild replaces the keyed crypto worker with a fresh keyless
 * one: with a pass-through worker that was a silent downgrade to plaintext
 * while the pill still said encrypted; with the fail-closed worker it would
 * still tear down a working encrypted call on a single injected message.
 */
import { WebRTCManager } from '../../website/client/static/js/webrtc.js';

class FakeSocket {
  constructor() {
    this._handlers = {};
    this.emitted = [];
  }
  on(event, handler) {
    (this._handlers[event] ??= []).push(handler);
  }
  emit(event, data) {
    this.emitted.push({ event, data });
  }
  async fire(event, data) {
    for (const cb of this._handlers[event] || []) await cb(data);
  }
}

class FakePeerConnection {
  constructor() {
    FakePeerConnection.instances.push(this);
    this.remoteDescriptions = [];
  }
  static instances = [];
  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'o' });
  }
  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'a' });
  }
  setLocalDescription(d) {
    this.localDescription = d;
    return Promise.resolve();
  }
  setRemoteDescription(d) {
    this.remoteDescriptions.push(d);
    return Promise.resolve();
  }
  addIceCandidate() {
    return Promise.resolve();
  }
  createDataChannel() {
    return { onopen: null, onmessage: null, onclose: null, close: () => {} };
  }
  close() {}
}

beforeEach(() => {
  FakePeerConnection.instances = [];
  globalThis.RTCPeerConnection = FakePeerConnection;
});

test('a second offer is ignored: no rebuilt connection, an error is surfaced', async () => {
  const socket = new FakeSocket();
  const manager = new WebRTCManager(socket, { enableEncryption: false });
  const errors = [];
  manager.on('error', (d) => errors.push(d));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await socket.fire('offer', { sdp: { type: 'offer', sdp: 'first' } });
  expect(FakePeerConnection.instances).toHaveLength(1);
  const first = FakePeerConnection.instances[0];
  expect(first.remoteDescriptions.map((d) => d.sdp)).toEqual(['first']);
  expect(socket.emitted.some((e) => e.event === 'answer')).toBe(true);

  await socket.fire('offer', { sdp: { type: 'offer', sdp: 'injected' } });
  // Still the ORIGINAL connection, untouched by the injected offer.
  expect(FakePeerConnection.instances).toHaveLength(1);
  expect(first.remoteDescriptions.map((d) => d.sdp)).toEqual(['first']);
  expect(errors.some((e) => /renegotiation/.test(e.message))).toBe(true);
  warn.mockRestore();
});

test('a flagged ICE-restart offer is applied to the EXISTING connection (key preserved)', async () => {
  const socket = new FakeSocket();
  const manager = new WebRTCManager(socket, { enableEncryption: false });
  const errors = [];
  manager.on('error', (d) => errors.push(d));

  await socket.fire('offer', { sdp: { type: 'offer', sdp: 'first' } });
  const first = FakePeerConnection.instances[0];

  // The one legitimate mid-call offer: an ICE restart. Applied in place — the
  // same pc, senders, transform and keyed worker are reused (no rebuild).
  await socket.fire('offer', { iceRestart: true, sdp: { type: 'offer', sdp: 'restart' } });
  expect(FakePeerConnection.instances).toHaveLength(1);
  expect(first.remoteDescriptions.map((d) => d.sdp)).toEqual(['first', 'restart']);
  expect(socket.emitted.filter((e) => e.event === 'answer')).toHaveLength(2);
  expect(errors).toHaveLength(0);
});

test('the initiator restarts ICE on a failed connection, reusing the same pc', async () => {
  const socket = new FakeSocket();
  const manager = new WebRTCManager(socket, { enableEncryption: false });
  const errors = [];
  manager.on('error', (d) => errors.push(d));

  await socket.fire('room-joined', { room_id: 'r', initiator: true });
  const pc = FakePeerConnection.instances[0];
  expect(socket.emitted.filter((e) => e.event === 'offer')).toHaveLength(1);

  pc.iceConnectionState = 'failed';
  pc.oniceconnectionstatechange();
  await vi.waitFor(() => expect(socket.emitted.filter((e) => e.event === 'offer')).toHaveLength(2));

  const offers = socket.emitted.filter((e) => e.event === 'offer');
  expect(offers[1].data.iceRestart).toBe(true);
  expect(FakePeerConnection.instances).toHaveLength(1); // reused, not rebuilt
  expect(errors).toHaveLength(0);
});

test('the answerer asks the initiator to restart ICE on a failed connection', async () => {
  const socket = new FakeSocket();
  const manager = new WebRTCManager(socket, { enableEncryption: false });
  manager.on('error', () => {});

  await socket.fire('offer', { sdp: { type: 'offer', sdp: 'first' } });
  const pc = FakePeerConnection.instances[0];

  pc.iceConnectionState = 'failed';
  pc.oniceconnectionstatechange();

  expect(socket.emitted.some((e) => e.event === 'request_ice_restart')).toBe(true);
  expect(socket.emitted.some((e) => e.event === 'offer')).toBe(false); // answerer never offers
});
