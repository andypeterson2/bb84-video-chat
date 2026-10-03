import { SimulatedQuantumChannel } from '../../../website/client/static/js/bb84/simulated.js';
import { MAX_QBER } from '../../../website/client/static/js/bench/distill.js';

function generateQubits(n) {
  return Array.from({ length: n }, () => ({
    bit: Math.random() < 0.5 ? 1 : 0,
    basis: Math.random() < 0.5 ? 1 : 0,
  }));
}

function computeQber(sent, received) {
  let errors = 0;
  let matching = 0;
  for (let i = 0; i < sent.length; i++) {
    const r = received[i];
    if (!r.detected) continue;
    if (r.basis === sent[i].basis) {
      matching++;
      if (r.bit !== sent[i].bit) errors++;
    }
  }
  return matching > 0 ? errors / matching : 0;
}

describe('SimulatedQuantumChannel', () => {
  test('without eavesdropper, QBER sits at the misalignment floor', async () => {
    const qbers = [];
    for (let round = 0; round < 10; round++) {
      const aliceCh = new SimulatedQuantumChannel({
        fiberLengthKm: 1.0,
        sourceIntensity: 0.5,
        detectorEfficiency: 0.5,
        eavesdropperEnabled: false,
      });
      const bobCh = aliceCh.createReceiver();

      const qubits = generateQubits(2000);
      await aliceCh.sendQubits(qubits);
      const received = await bobCh.receiveQubits();
      const qber = computeQber(qubits, received);
      qbers.push(qber);
    }

    const avgQber = qbers.reduce((a, b) => a + b, 0) / qbers.length;
    // Misalignment is 1.5% by default, and a quiet channel has to show it: a
    // zero-error channel would skip the correction the error rate pays for.
    expect(avgQber).toBeGreaterThan(0.005);
    expect(avgQber).toBeLessThan(0.03);
    // Still well inside what the distillation can mint from.
    expect(avgQber).toBeLessThan(MAX_QBER);
  });

  test('with eavesdropper, QBER lands far above the mint ceiling', async () => {
    const qbers = [];
    for (let round = 0; round < 10; round++) {
      const aliceCh = new SimulatedQuantumChannel({
        fiberLengthKm: 1.0,
        sourceIntensity: 0.5,
        detectorEfficiency: 0.5,
        eavesdropperEnabled: true,
      });
      const bobCh = aliceCh.createReceiver();

      const qubits = generateQubits(2000);
      await aliceCh.sendQubits(qubits);
      const received = await bobCh.receiveQubits();
      const qber = computeQber(qubits, received);
      qbers.push(qber);
    }

    const avgQber = qbers.reduce((a, b) => a + b, 0) / qbers.length;
    // Intercept-resend costs a quarter of the sifted bits, so the margin over
    // the ceiling is wide enough that one frame's sample decides.
    expect(avgQber).toBeGreaterThan(0.2);
  });

  test('detection rate is approximately sourceIntensity * detectorEfficiency', async () => {
    const intensity = 0.3;
    const efficiency = 0.4;
    const expectedRate = intensity * efficiency;

    const aliceCh = new SimulatedQuantumChannel({
      fiberLengthKm: 0.0, // no fiber loss
      sourceIntensity: intensity,
      detectorEfficiency: efficiency,
      eavesdropperEnabled: false,
    });
    const bobCh = aliceCh.createReceiver();

    const qubits = generateQubits(5000);
    await aliceCh.sendQubits(qubits);
    const received = await bobCh.receiveQubits();

    const detected = received.filter((q) => q.detected).length;
    const actualRate = detected / qubits.length;

    // Within 50% tolerance
    expect(actualRate).toBeGreaterThan(expectedRate * 0.5);
    expect(actualRate).toBeLessThan(expectedRate * 1.5);
  });

  test('fiber attenuation reduces detection rate for longer fibers', async () => {
    async function getDetectionRate(fiberLength) {
      const aliceCh = new SimulatedQuantumChannel({
        fiberLengthKm: fiberLength,
        sourceIntensity: 0.5,
        detectorEfficiency: 0.5,
        eavesdropperEnabled: false,
      });
      const bobCh = aliceCh.createReceiver();

      const qubits = generateQubits(5000);
      await aliceCh.sendQubits(qubits);
      const received = await bobCh.receiveQubits();
      return received.filter((q) => q.detected).length / qubits.length;
    }

    const rateShort = await getDetectionRate(1.0);
    const rateLong = await getDetectionRate(50.0);

    expect(rateLong).toBeLessThan(rateShort);
  });
});
