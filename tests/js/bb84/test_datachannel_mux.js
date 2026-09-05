/**
 * Hardening tests for DataChannelMux — the seam where a hostile peer's raw
 * DataChannel bytes enter the BB84 stack.
 */
import { describe, test, expect } from 'vitest';
import { DataChannelMux } from '../../../website/client/static/js/bb84/datachannel-adapter.js';

describe('DataChannelMux hardening', () => {
  test('malformed JSON is dropped without throwing', () => {
    const mux = new DataChannelMux(() => {});
    expect(() => mux.handleMessage('not json {{{')).not.toThrow();
    expect(() => mux.handleMessage('')).not.toThrow();
  });

  test('unknown channel names are discarded', async () => {
    const mux = new DataChannelMux(() => {});
    mux.handleMessage(JSON.stringify({ ch: '__proto__', payload: 'x' }));
    mux.handleMessage(JSON.stringify({ ch: 'constructor', payload: 'x' }));
    mux.handleMessage(JSON.stringify({ ch: 'other', payload: 'x' }));
    // Nothing buffered anywhere — a later legit message is the first delivery.
    mux.handleMessage(JSON.stringify({ ch: 'classical', payload: 'real' }));
    await expect(mux.receive('classical')).resolves.toBe('real');
  });

  test('non-object and null messages are discarded', () => {
    const mux = new DataChannelMux(() => {});
    expect(() => mux.handleMessage('null')).not.toThrow();
    expect(() => mux.handleMessage('"string"')).not.toThrow();
    expect(() => mux.handleMessage('42')).not.toThrow();
  });

  test('buffer is capped against floods', async () => {
    const mux = new DataChannelMux(() => {});
    for (let i = 0; i < 500; i++) {
      mux.handleMessage(JSON.stringify({ ch: 'classical', payload: i }));
    }
    let drained = 0;
    // Drain synchronously-resolvable receives; the cap bounds what was kept.
    while (drained < 500) {
      const q = mux._getQueue('classical');
      if (q.buffer.length === 0) break;
      await mux.receive('classical');
      drained++;
    }
    expect(drained).toBeLessThanOrEqual(64);
    expect(drained).toBeGreaterThan(0);
  });

  test('waiters are still served ahead of buffering', async () => {
    const mux = new DataChannelMux(() => {});
    const pending = mux.receive('quantum');
    mux.handleMessage(JSON.stringify({ ch: 'quantum', payload: [1, 2, 3] }));
    await expect(pending).resolves.toEqual([1, 2, 3]);
  });
});

describe('DataChannelMux chunking', () => {
  /** Wire two muxes together like a real (ordered, reliable) DataChannel. */
  function pair() {
    let a, b;
    a = new DataChannelMux((raw) => b.handleMessage(raw));
    b = new DataChannelMux((raw) => a.handleMessage(raw));
    return [a, b];
  }

  test('large payloads survive the SCTP-size chunking round trip', async () => {
    const [a, b] = pair();
    // ~8192 simulated qubits — the payload that exceeds SCTP message limits.
    const qubits = Array.from({ length: 8192 }, (_, i) => ({
      bit: i % 2,
      basis: (i >> 1) % 2,
      detected: i % 3 === 0,
    }));
    a.send('quantum', qubits);
    const received = await b.receive('quantum');
    expect(received).toEqual(qubits);
  });

  test('small payloads are not chunked', () => {
    const sent = [];
    const mux = new DataChannelMux((raw) => sent.push(raw));
    mux.send('classical', { type: 'abort' });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).ch).toBe('classical');
  });

  test('oversized payloads throw instead of silently killing the channel', () => {
    const mux = new DataChannelMux(() => {});
    const huge = 'x'.repeat(32 * 60 * 1024 + 1);
    expect(() => mux.send('classical', huge)).toThrow(/too large/);
  });

  test('malformed chunk metadata drops the partial without throwing', async () => {
    const mux = new DataChannelMux(() => {});
    mux.handleMessage(JSON.stringify({ chunk: { id: 0, index: 0, total: 999 }, data: 'x' }));
    mux.handleMessage(JSON.stringify({ chunk: { id: 0, index: 'a', total: 2 }, data: 'x' }));
    mux.handleMessage(JSON.stringify({ chunk: { id: 0, index: 1, total: 2 } })); // no data
    // A legit message still flows afterwards.
    mux.handleMessage(JSON.stringify({ ch: 'classical', payload: 'ok' }));
    await expect(mux.receive('classical')).resolves.toBe('ok');
  });

  test('a reassembled message cannot itself be a chunk envelope', () => {
    const mux = new DataChannelMux(() => {});
    // Nested chunk-in-chunk: outer reassembles to another chunk envelope,
    // which the recursion guard must discard rather than process.
    const inner = JSON.stringify({ chunk: { id: 7, index: 0, total: 1 }, data: 'x' });
    mux.handleMessage(JSON.stringify({ chunk: { id: 1, index: 0, total: 1 }, data: inner }));
    expect(mux._partial).toBeNull();
    expect(Object.keys(mux._queues)).toHaveLength(0);
  });
});
