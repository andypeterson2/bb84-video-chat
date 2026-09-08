/**
 * ReservoirEngine.forceRotate() — the demo hook that installs the next pooled
 * key immediately, bypassing the rotation-floor wait. Normal rotation is floored
 * (ROTATION_FLOOR_MS) so a fast-minting reservoir doesn't churn the cipher;
 * forceRotate collapses that wait for an on-demand demo rotation, but only when a
 * key is actually pending and the engine is healthy.
 */
import { ReservoirEngine } from '../../../website/client/static/js/bench/reservoir.js';

/** Build an engine with inert deps; forceRotate touches none of the transport. */
function makeEngine() {
  const installed = [];
  const states = [];
  const engine = new ReservoirEngine({
    mux: {},
    makeClassicalChannel: () => ({}),
    frameSource: { role: 'source' },
    installKey: (key, keyIndex) => installed.push(keyIndex),
    onState: (s) => states.push(s),
  });
  return { engine, installed, states };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('installs a pending key immediately, bypassing the 10s floor', async () => {
  const { engine, installed, states } = makeEngine();
  engine._pendingKeys.push({ key: new Uint8Array(16), keyIndex: 0 });
  engine._lastInstallAt = Date.now(); // floor active: a normal wait would be ~10s

  engine.forceRotate();
  await tick();

  expect(installed).toEqual([0]);
  const rotated = states.find((s) => s.phase === 'rotated');
  expect(rotated).toBeDefined();
  expect(rotated.keyIndex).toBe(0);
  expect(engine._pendingKeys).toHaveLength(0);
});

test('is a no-op when no key is pending', async () => {
  const { engine, installed, states } = makeEngine();
  engine.forceRotate();
  await tick();
  expect(installed).toEqual([]);
  expect(states).toHaveLength(0);
});

test('is a no-op once the engine is latched (exhausted) or destroyed', async () => {
  const { engine, installed } = makeEngine();
  engine._pendingKeys.push({ key: new Uint8Array(16), keyIndex: 0 });
  engine._exhausted = true;
  engine.forceRotate();
  await tick();
  expect(installed).toEqual([]);

  engine._exhausted = false;
  engine._destroyed = true;
  engine.forceRotate();
  await tick();
  expect(installed).toEqual([]);
});
