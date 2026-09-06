/**
 * DaemonConnection + DaemonFrameSource against a fake WebSocket.
 *
 * The daemon speaks the same sparse encoding as the browser's frame protocol,
 * so these tests pin pairing/role discovery, the transmit→frame-sent
 * round-trip, detection decoding, and the eve control — without a live socket.
 */
import {
  DaemonConnection,
  DaemonFrameSource,
  decodeDaemonDetections,
} from '../../../website/client/static/js/bench/daemon-source.js';
import { packBits, encodeIndices, toB64 } from '../../../website/client/static/js/bench/packing.js';

/** A controllable fake WebSocket matching the browser API surface we use. */
class FakeWS {
  constructor() {
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeWS.instances.push(this);
  }
  static instances = [];
  static OPEN = 1;
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  // Test drivers:
  fireOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  FakeWS.instances = [];
  globalThis.WebSocket = FakeWS;
});

afterEach(() => {
  delete globalThis.WebSocket;
});

function connect({ token = 'tok' } = {}) {
  const conn = new DaemonConnection({ url: 'ws://x', token, wsFactory: (u) => new FakeWS(u) });
  const promise = conn.connect();
  const ws = FakeWS.instances.at(-1);
  return { conn, ws, promise };
}

describe('DaemonConnection pairing', () => {
  test('sends the token on open and resolves with the daemon role', async () => {
    const { conn, ws, promise } = connect();
    ws.fireOpen();
    expect(ws.sent[0]).toMatchObject({ t: 'pair', token: 'tok' });
    ws.deliver({ t: 'paired', role: 'detector', slots_per_frame: 8000 });
    await promise;
    expect(conn.role).toBe('detector');
  });

  test('a refusal rejects the connect promise', async () => {
    const { ws, promise } = connect();
    ws.fireOpen();
    ws.deliver({ t: 'refused', reason: 'bad token' });
    await expect(promise).rejects.toThrow(/bad token/);
  });

  test('a socket close before pairing rejects', async () => {
    const { ws, promise } = connect();
    ws.close();
    await expect(promise).rejects.toThrow(/closed/);
  });
});

describe('DaemonFrameSource (source role)', () => {
  test('transmit sends a packed frame and resolves on frame-sent', async () => {
    const { conn, ws, promise } = connect();
    ws.fireOpen();
    ws.deliver({ t: 'paired', role: 'source' });
    await promise;
    const source = new DaemonFrameSource(conn);
    expect(source.role).toBe('source');

    const bits = Uint8Array.of(1, 0, 1, 1);
    const bases = Uint8Array.of(0, 1, 0, 1);
    const txPromise = source.transmit({ frameId: 0, bits, bases });
    const sent = ws.sent.at(-1);
    expect(sent).toMatchObject({ t: 'transmit', frame_id: 0, slots: 4 });
    ws.deliver({ t: 'frame-sent', frame_id: 0, tx_epoch_ps: 999 });
    await txPromise; // resolves only on the matching frame-sent
  });

  test('eve control sends an eve message', async () => {
    const { conn, ws, promise } = connect();
    ws.fireOpen();
    ws.deliver({ t: 'paired', role: 'source' });
    await promise;
    const source = new DaemonFrameSource(conn);
    source.setEavesdropper(true);
    expect(ws.sent.at(-1)).toEqual({ t: 'eve', enabled: true });
  });
});

describe('DaemonFrameSource (detector role)', () => {
  test('surfaces decoded detections from the daemon', async () => {
    const { conn, ws, promise } = connect();
    ws.fireOpen();
    ws.deliver({ t: 'paired', role: 'detector' });
    await promise;
    const source = new DaemonFrameSource(conn);
    const got = [];
    source.onDetections((d) => got.push(d));

    ws.deliver({
      t: 'detections',
      frame_id: 3,
      count: 3,
      indices: toB64(encodeIndices([2, 5, 9])),
      bits: toB64(packBits([1, 0, 1])),
      bases: toB64(packBits([0, 1, 1])),
      stats: { lock: { quality: 1 } },
    });
    expect(got).toHaveLength(1);
    expect(got[0].frameId).toBe(3);
    expect(Array.from(got[0].indices)).toEqual([2, 5, 9]);
    expect(Array.from(got[0].bits)).toEqual([1, 0, 1]);
    expect(Array.from(got[0].bases)).toEqual([0, 1, 1]);
  });

  test('transmit and eve are rejected on a detector source', async () => {
    const { conn, ws, promise } = connect();
    ws.fireOpen();
    ws.deliver({ t: 'paired', role: 'detector' });
    await promise;
    const source = new DaemonFrameSource(conn);
    await expect(
      source.transmit({ frameId: 0, bits: new Uint8Array(1), bases: new Uint8Array(1) }),
    ).rejects.toThrow(/source-role/);
    expect(() => source.setEavesdropper(true)).toThrow(/source/);
  });
});

describe('decodeDaemonDetections', () => {
  test('round-trips the sparse encoding', () => {
    const msg = {
      frame_id: 1,
      count: 2,
      indices: toB64(encodeIndices([0, 4])),
      bits: toB64(packBits([1, 1])),
      bases: toB64(packBits([0, 1])),
    };
    const d = decodeDaemonDetections(msg);
    expect(Array.from(d.indices)).toEqual([0, 4]);
    expect(Array.from(d.bits)).toEqual([1, 1]);
  });
});
