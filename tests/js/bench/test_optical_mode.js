/**
 * Optical-mode end to end: two reservoir engines, each fed by its OWN daemon
 * (not the mux), mint matching keys over the peers' authenticated channel.
 *
 * This is the Stage-C wiring proof: in optical mode the source browser's
 * frame source transmits to a daemon; the quantum part crosses a (here fake)
 * fiber to the detector's daemon, which surfaces detections to the detector
 * browser; the classical reconciliation still rides the mux. A daemon-backed
 * detector exposes no `deliverDetections`, so the engine must NOT wire the mux
 * 'quantum' listener for it.
 */
import {
  DataChannelMux,
  DataChannelClassicalChannel,
} from '../../../website/client/static/js/bb84/datachannel-adapter.js';
import { ReservoirEngine } from '../../../website/client/static/js/bench/reservoir.js';
import { DaemonFrameSource } from '../../../website/client/static/js/bench/daemon-source.js';
import { SimulatedQuantumChannel } from '../../../website/client/static/js/bb84/simulated.js';

beforeEach(() => {
  globalThis.QVC_FRAME_PERIOD_MS = 5;
  globalThis.QVC_FRAME_DEADLINE_MS = 800;
  globalThis.QVC_STREAM_WATCHDOG_MS = 1500;
  globalThis.QVC_ROTATION_FLOOR_MS = 0;
  globalThis.QVC_SESSION_RESTART_DELAY_MS = 20;
});
afterEach(() => {
  for (const k of Object.keys(globalThis).filter((n) => n.startsWith('QVC_'))) delete globalThis[k];
});

/**
 * A pair of fake daemon connections joined by a fake fiber. The source conn's
 * transmit() simulates the optical bench (loss + detection) and delivers the
 * sparse detection set to the detector conn's onDetections — exactly the shape
 * DaemonConnection surfaces from a real daemon.
 */
function fakeDaemonPair({ eavesdropper = { on: false } } = {}) {
  let detectorCb = null;
  const channelOptions = { fiberLengthKm: 1.0, sourceIntensity: 0.5, detectorEfficiency: 0.5 };

  const sourceConn = {
    role: 'source',
    startAcquisition: async () => {},
    stopAcquisition: async () => {},
    onDetections: () => {},
    onStatus: () => {},
    setEavesdropper: (v) => {
      eavesdropper.on = !!v;
    },
    transmit: async (frameId, bits, bases) => {
      const sim = new SimulatedQuantumChannel({
        ...channelOptions,
        eavesdropperEnabled: eavesdropper.on,
      });
      const receiver = sim.createReceiver();
      const qubits = Array.from(bits, (b, i) => ({ bit: b, basis: bases[i] }));
      await sim.sendQubits(qubits);
      const transmitted = await receiver.receiveQubits();
      const indices = [];
      const detBits = [];
      const detBases = [];
      for (let i = 0; i < bits.length; i++) {
        if (transmitted[i].detected === false) continue;
        const mb = Math.random() < 0.5 ? 0 : 1;
        indices.push(i);
        detBases.push(mb);
        detBits.push(
          mb === transmitted[i].basis ? transmitted[i].bit : Math.random() < 0.5 ? 0 : 1,
        );
      }
      // Deliver to the detector daemon (async, like a real fiber + WS hop).
      Promise.resolve().then(() =>
        detectorCb?.({
          frameId,
          indices: Uint32Array.from(indices),
          bits: Uint8Array.from(detBits),
          bases: Uint8Array.from(detBases),
          stats: { detections: indices.length },
        }),
      );
    },
  };

  const detectorConn = {
    role: 'detector',
    startAcquisition: async () => {},
    stopAcquisition: async () => {},
    onDetections: (cb) => {
      detectorCb = cb;
    },
    onStatus: () => {},
  };

  return { sourceConn, detectorConn };
}

function opticalPair() {
  const muxes = {};
  const installed = { source: [], detector: [] };
  const states = { source: [], detector: [] };
  for (const [self, other] of [
    ['source', 'detector'],
    ['detector', 'source'],
  ]) {
    muxes[self] = new DataChannelMux((raw) =>
      Promise.resolve().then(() => muxes[other]?.handleMessage(raw)),
    );
  }
  const eve = { on: false };
  const { sourceConn, detectorConn } = fakeDaemonPair({ eavesdropper: eve });

  const engines = {};
  for (const [self, conn] of [
    ['source', sourceConn],
    ['detector', detectorConn],
  ]) {
    engines[self] = new ReservoirEngine({
      mux: muxes[self],
      makeClassicalChannel: (_domain, signal) =>
        new DataChannelClassicalChannel(muxes[self], signal),
      frameSource: new DaemonFrameSource(conn),
      installKey: (key, keyIndex) => installed[self].push({ key, keyIndex }),
      onState: (s) => states[self].push(s),
      slotsPerFrame: 2048,
    });
  }

  return {
    engines,
    installed,
    states,
    eve,
    start: () => {
      engines.source.start();
      engines.detector.start();
    },
    destroy: () => {
      engines.source.destroy();
      engines.detector.destroy();
    },
    untilInstalled: (n) =>
      vi.waitFor(
        () => {
          expect(installed.source.length).toBeGreaterThanOrEqual(n);
          expect(installed.detector.length).toBeGreaterThanOrEqual(n);
        },
        { timeout: 8000, interval: 25 },
      ),
    phases: (side, ph) => states[side].filter((s) => s.phase === ph),
  };
}

describe('optical mode (daemon-fed reservoir)', () => {
  test('both browsers mint identical keys from daemon detections', async () => {
    const p = opticalPair();
    try {
      p.start();
      await p.untilInstalled(1);
      expect(p.installed.source[0].keyIndex).toBe(0);
      expect(Array.from(p.installed.source[0].key)).toEqual(
        Array.from(p.installed.detector[0].key),
      );
    } finally {
      p.destroy();
    }
  });

  test('the eavesdropper latches the optical channel red', async () => {
    const p = opticalPair();
    try {
      p.engines.source.setEavesdropper(true);
      p.start();
      await vi.waitFor(
        () => {
          expect(p.phases('source', 'exhausted').length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 8000, interval: 25 },
      );
      expect(p.installed.source).toHaveLength(0);
    } finally {
      p.destroy();
    }
  });
});
