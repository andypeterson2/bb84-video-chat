/**
 * pipelineModel — the pure projection of a telemetry snapshot into the hero's
 * per-stage state. The QBER gate closing on an over-threshold error rate is the
 * eavesdropper-detection moment; the source stage is labeled honestly
 * (SIMULATED vs OPTICAL). The canvas animation itself is browser-verified.
 */
import { pipelineModel, STAGES } from '../../website/client/static/js/analytics/pipeline.js';

const stageOf = (m, key) => m.stages.find((s) => s.key === key);

test('an inactive snapshot leaves every stage idle', () => {
  const m = pipelineModel({ inCall: false });
  expect(m.active).toBe(false);
  expect(m.stages).toHaveLength(STAGES.length);
  expect(m.stages.every((s) => s.status === 'idle')).toBe(true);
});

test('a healthy live channel opens the gate and encrypts', () => {
  const m = pipelineModel({
    inCall: true,
    bb84Active: true,
    mode: 'sim',
    qber: 0.02,
    qberThreshold: 0.11,
    qberWarning: 0.08,
    cipherState: 'encrypted',
  });
  expect(m.active).toBe(true);
  expect(m.gateOpen).toBe(true);
  expect(m.compromised).toBe(false);
  expect(stageOf(m, 'qber').status).toBe('ok');
  expect(stageOf(m, 'encrypt').status).toBe('ok');
});

test('an over-threshold QBER closes the gate and marks the channel compromised', () => {
  const m = pipelineModel({
    inCall: true,
    bb84Active: true,
    mode: 'sim',
    qber: 0.24,
    qberThreshold: 0.11,
    qberWarning: 0.08,
    cipherState: 'compromised',
  });
  expect(m.gateOpen).toBe(false);
  expect(m.compromised).toBe(true);
  expect(stageOf(m, 'qber').status).toBe('reject');
  expect(stageOf(m, 'encrypt').status).toBe('reject');
});

test('an elevated-but-below-threshold QBER warns without closing the gate', () => {
  const m = pipelineModel({
    inCall: true,
    bb84Active: true,
    qber: 0.09,
    qberThreshold: 0.11,
    qberWarning: 0.08,
  });
  expect(m.gateOpen).toBe(true);
  expect(stageOf(m, 'qber').status).toBe('warn');
});

test('the source stage is labeled honestly by backend', () => {
  const sim = pipelineModel({ inCall: true, bb84Active: true, mode: 'sim' });
  const opt = pipelineModel({ inCall: true, bb84Active: true, mode: 'optical' });
  expect(stageOf(sim, 'source').label).toBe('SIMULATED');
  expect(stageOf(opt, 'source').label).toBe('OPTICAL');
  expect(sim.modeLabel).toBe('SIMULATED');
  expect(opt.modeLabel).toBe('OPTICAL');
});

test('a recent mint/rotate event lights up its stage; a stale one does not', () => {
  const now = 1_000_000;
  const snap = {
    inCall: true,
    bb84Active: true,
    events: [
      { t: now - 500, kind: 'minted' }, // recent
      { t: now - 9000, kind: 'rotated' }, // stale
    ],
  };
  const m = pipelineModel(snap, now);
  expect(stageOf(m, 'distill').glow).toBe(true);
  expect(stageOf(m, 'rotate').glow).toBe(false);
});
