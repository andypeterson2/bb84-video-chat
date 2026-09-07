/**
 * QualityController — drives adaptation off the browser's own bandwidth
 * estimate (availableOutgoingBitrate) and caps the encoder via the sender's
 * maxBitrate, with hysteresis so a single noisy sample doesn't thrash quality.
 */
import { QualityController } from '../../website/client/static/js/quality.js';

function statsMap({ availableOutgoingBitrate, qualityLimitationReason = 'none' }) {
  return new Map([
    [
      'cp',
      {
        type: 'candidate-pair',
        nominated: true,
        currentRoundTripTime: 0.05,
        availableOutgoingBitrate,
      },
    ],
    [
      'out',
      {
        type: 'outbound-rtp',
        kind: 'video',
        bytesSent: 0,
        framesPerSecond: 30,
        frameWidth: 640,
        frameHeight: 480,
        qualityLimitationReason,
      },
    ],
    [
      'in',
      {
        type: 'inbound-rtp',
        kind: 'video',
        framesPerSecond: 30,
        frameWidth: 640,
        frameHeight: 480,
      },
    ],
  ]);
}

class FakeSender {
  constructor() {
    this._params = { encodings: [{}] };
    this.appliedBitrates = [];
  }
  getParameters() {
    return this._params;
  }
  setParameters(p) {
    this._params = p;
    this.appliedBitrates.push(p.encodings[0].maxBitrate);
    return Promise.resolve();
  }
}

function makeController({ sender } = {}) {
  let stats = statsMap({ availableOutgoingBitrate: 1_200_000 });
  const pc = { getStats: async () => stats };
  const localStream = { getVideoTracks: () => [{ applyConstraints: () => Promise.resolve() }] };
  const updates = [];
  const controller = new QualityController({
    pc,
    localStream,
    sender,
    onUpdate: (u) => updates.push(u),
  });
  return { controller, updates, setStats: (s) => (stats = s) };
}

/** Drive N poll cycles (hysteresis needs 3 to commit a tier change). */
async function poll(controller, n = 1) {
  for (let i = 0; i < n; i++) await controller._poll();
}

test('a sustained low estimate lowers the tier and caps the encoder bitrate', async () => {
  const sender = new FakeSender();
  const { controller, updates, setStats } = makeController({ sender });

  setStats(statsMap({ availableOutgoingBitrate: 300_000, qualityLimitationReason: 'bandwidth' }));
  await poll(controller, 3); // hysteresis: 3 confirming samples

  const last = updates.at(-1);
  expect(last.tier).toBe('Low');
  expect(last.bandwidthKbps).toBe(300);
  expect(last.limitedBy).toBe('bandwidth');
  // Encoder capped at the Low tier's target (400 kbps).
  expect(sender.appliedBitrates.at(-1)).toBe(400_000);
});

test('hysteresis: a single low sample does not switch tiers', async () => {
  const sender = new FakeSender();
  const { controller, updates, setStats } = makeController({ sender });

  setStats(statsMap({ availableOutgoingBitrate: 300_000 }));
  await poll(controller, 1);
  await poll(controller, 1); // back-to-back but only 2 confirming samples so far

  // Still at the starting SD tier — not enough confirmations to drop.
  expect(updates.at(-1).tier).toBe('SD');
  expect(sender.appliedBitrates).toHaveLength(0);
});

test('a sustained high estimate raises the tier and bitrate back up', async () => {
  const sender = new FakeSender();
  const { controller, setStats } = makeController({ sender });

  setStats(statsMap({ availableOutgoingBitrate: 300_000 }));
  await poll(controller, 3);
  expect(sender.appliedBitrates.at(-1)).toBe(400_000);

  setStats(statsMap({ availableOutgoingBitrate: 3_000_000 }));
  await poll(controller, 3);
  expect(sender.appliedBitrates.at(-1)).toBe(2_500_000); // HD target
});

test('no sender: adaptation still runs (resolution ladder) without throwing', async () => {
  const { controller, updates, setStats } = makeController({ sender: undefined });
  setStats(statsMap({ availableOutgoingBitrate: 300_000 }));
  await expect(poll(controller, 3)).resolves.toBeUndefined();
  expect(updates.at(-1).tier).toBe('Low');
});
