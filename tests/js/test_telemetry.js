/**
 * Telemetry contract for the analytics bus: the snapshot builder carries only
 * real readings (null when absent, never fabricated), the event log is a bounded
 * ring buffer, and the command allowlist rejects anything off-list.
 */
import {
  buildTelemetrySnapshot,
  EventLog,
  isValidCommand,
  COMMANDS,
  TELEMETRY_CHANNEL,
} from '../../website/client/static/js/analytics/telemetry.js';

describe('buildTelemetrySnapshot', () => {
  const liveState = {
    peerConnected: true,
    bb84Active: true,
    elapsed: 42,
    mode: 'sim',
    cipherState: 'encrypted',
    keyIndex: 3,
    qber: 0.02,
    qberHistory: [0.01, 0.02, 0.03],
    keysMinted: 7,
    rotations: 2,
    poolDepth: 1,
    reservoirBits: 140,
    mintBudget: 256,
    sas: { digits: '481920', emoji: ['🐙', '🦊', '🐢', '🦉'] },
    sasVerified: true,
    isInitiator: true,
    eavesdropper: false,
    peerEavesdropping: false,
    reconnecting: false,
    quality: { bandwidthKbps: 5200, rttMs: 42, tier: 'Full HD', limitedBy: 'cpu' },
    cryptoMetrics: { encryptLatencyUs: 47, decryptLatencyUs: 39 },
  };

  test('carries the real pipeline readings and derives distillFraction', () => {
    const snap = buildTelemetrySnapshot(liveState, { now: 1000 });
    expect(snap.type).toBe('telemetry');
    expect(snap.t).toBe(1000);
    expect(snap.inCall).toBe(true);
    expect(snap.qber).toBe(0.02);
    expect(snap.qberHistory).toEqual([0.01, 0.02, 0.03]);
    expect(snap.keysMinted).toBe(7);
    expect(snap.distillFraction).toBeCloseTo(140 / 256, 5);
    expect(snap.quality.tier).toBe('Full HD');
    expect(snap.crypto.encryptLatencyUs).toBe(47);
    expect(snap.isInitiator).toBe(true);
  });

  test('copies the QBER history (mutating the snapshot never touches state)', () => {
    const snap = buildTelemetrySnapshot(liveState, {});
    snap.qberHistory.push(0.99);
    expect(liveState.qberHistory).toEqual([0.01, 0.02, 0.03]);
  });

  test('threads through extras: fingerprints, events, thresholds', () => {
    const snap = buildTelemetrySnapshot(liveState, {
      fingerprints: { local: 'AA', remote: 'BB' },
      events: [{ t: 1, kind: 'minted', detail: null }],
      qberThreshold: 0.11,
      qberWarning: 0.08,
    });
    expect(snap.fingerprints).toEqual({ local: 'AA', remote: 'BB' });
    expect(snap.events).toHaveLength(1);
    expect(snap.qberThreshold).toBe(0.11);
    expect(snap.qberWarning).toBe(0.08);
  });

  test('an empty/pre-call state yields an honest null-filled snapshot, not fake data', () => {
    const snap = buildTelemetrySnapshot({}, { now: 0 });
    expect(snap.inCall).toBe(false);
    expect(snap.qber).toBeNull();
    expect(snap.qberHistory).toEqual([]);
    expect(snap.keysMinted).toBe(0);
    expect(snap.quality).toBeNull();
    expect(snap.crypto).toBeNull();
    expect(snap.distillFraction).toBe(0); // no mintBudget ⇒ 0, not NaN
    expect(snap.sas).toBeNull();
  });
});

describe('EventLog', () => {
  test('appends timestamped events and returns them oldest-first', () => {
    const log = new EventLog(10);
    log.log('minted', { keyIndex: 0 }, 100);
    log.log('rotated', { keyIndex: 0 }, 200);
    const tail = log.tail();
    expect(tail).toEqual([
      { t: 100, kind: 'minted', detail: { keyIndex: 0 } },
      { t: 200, kind: 'rotated', detail: { keyIndex: 0 } },
    ]);
  });

  test('is bounded: oldest entries drop past the cap', () => {
    const log = new EventLog(3);
    for (let i = 0; i < 5; i++) log.log('minted', null, i);
    expect(log.size).toBe(3);
    expect(log.tail().map((e) => e.t)).toEqual([2, 3, 4]);
  });

  test('tail(n) returns just the most recent n; clear empties it', () => {
    const log = new EventLog(10);
    for (let i = 0; i < 5; i++) log.log('x', null, i);
    expect(log.tail(2).map((e) => e.t)).toEqual([3, 4]);
    log.clear();
    expect(log.size).toBe(0);
  });
});

describe('command allowlist', () => {
  test('accepts exactly the allowlisted commands', () => {
    for (const cmd of COMMANDS) {
      expect(isValidCommand({ type: 'command', cmd })).toBe(true);
    }
  });

  test('rejects off-list commands, wrong type, and junk', () => {
    expect(isValidCommand({ type: 'command', cmd: 'rm -rf' })).toBe(false);
    expect(isValidCommand({ type: 'telemetry', cmd: 'reset' })).toBe(false);
    expect(isValidCommand({ cmd: 'reset' })).toBe(false);
    expect(isValidCommand(null)).toBe(false);
    expect(isValidCommand('reset')).toBe(false);
  });

  test('the channel name is a stable constant', () => {
    expect(TELEMETRY_CHANNEL).toBe('qvc-analytics');
  });
});
