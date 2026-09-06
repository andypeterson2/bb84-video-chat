/**
 * LoopbackFrameSource: the simulator as a bench. The source runs the whole
 * optical path and emits a sparse detection set; role guards keep source-only
 * and detector-only operations honest.
 */
import { LoopbackFrameSource } from '../../../website/client/static/js/bench/loopback-source.js';
import { randomBits } from '../../../website/client/static/js/bench/packing.js';

describe('LoopbackFrameSource', () => {
  test('a source frame emits a sparse, ordered, well-shaped detection set', async () => {
    let delivered = null;
    const src = new LoopbackFrameSource({ role: 'source', sendToPeer: (d) => (delivered = d) });
    await src.start();
    const slots = 4096;
    await src.transmit({ frameId: 7, bits: randomBits(slots), bases: randomBits(slots) });

    expect(delivered).not.toBeNull();
    expect(delivered.frameId).toBe(7);
    expect(delivered.indices.length).toBeGreaterThan(0);
    expect(delivered.indices.length).toBeLessThan(slots); // sparse (loss)
    expect(delivered.bits.length).toBe(delivered.indices.length);
    expect(delivered.bases.length).toBe(delivered.indices.length);
    // Indices ascending and in range.
    for (let i = 1; i < delivered.indices.length; i++) {
      expect(delivered.indices[i]).toBeGreaterThan(delivered.indices[i - 1]);
    }
    expect(delivered.indices[delivered.indices.length - 1]).toBeLessThan(slots);
  });

  test('the eavesdropper raises the matched-basis error rate', async () => {
    // Compare bit-error among basis-matched detections with Eve off vs on.
    const errorRate = async (eve) => {
      let total = 0;
      let errors = 0;
      for (let f = 0; f < 6; f++) {
        const bits = randomBits(4096);
        const bases = randomBits(4096);
        let det = null;
        const src = new LoopbackFrameSource({
          role: 'source',
          sendToPeer: (d) => (det = d),
          channelOptions: { fiberLengthKm: 0.1, sourceIntensity: 0.9, detectorEfficiency: 0.9 },
        });
        await src.start();
        if (eve) src.setEavesdropper(true);
        await src.transmit({ frameId: f, bits, bases });
        for (let k = 0; k < det.indices.length; k++) {
          const slot = det.indices[k];
          if (det.bases[k] === bases[slot]) {
            total++;
            if (det.bits[k] !== bits[slot]) errors++;
          }
        }
      }
      return errors / total;
    };
    const clean = await errorRate(false);
    const tapped = await errorRate(true);
    expect(clean).toBeLessThan(0.05);
    expect(tapped).toBeGreaterThan(0.15); // intercept-resend ~25% on matched basis
  });

  test('role guards reject cross-role operations', async () => {
    const detector = new LoopbackFrameSource({ role: 'detector' });
    await expect(
      detector.transmit({ frameId: 0, bits: new Uint8Array(1), bases: new Uint8Array(1) }),
    ).rejects.toThrow(/source-role/);
    expect(() => detector.setEavesdropper(true)).toThrow(/source/);

    const source = new LoopbackFrameSource({ role: 'source' });
    expect(() => source.deliverDetections({ frameId: 0 })).toThrow(/detector-role/);
  });

  test('detector role routes delivered detections to its callback', () => {
    const detector = new LoopbackFrameSource({ role: 'detector' });
    let got = null;
    detector.onDetections((d) => (got = d));
    const payload = {
      frameId: 3,
      indices: Uint32Array.of(1, 2),
      bits: Uint8Array.of(0, 1),
      bases: Uint8Array.of(1, 0),
    };
    detector.deliverDetections(payload);
    expect(got).toEqual(payload);
  });
});
