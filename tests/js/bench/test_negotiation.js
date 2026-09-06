/**
 * Backend negotiation: optical engages only for complementary bench roles,
 * everything else falls back to simulated — never silently, never one-sided.
 */
import { negotiateBackend, PROTO_V } from '../../../website/client/static/js/bench/negotiation.js';

/** Two authenticated one-shot channels wired to each other. */
function channelPair() {
  const q = [[], []];
  const w = [[], []];
  const make = (mine, theirs) => ({
    send: async (msg) => {
      const waiter = w[theirs].shift();
      if (waiter) waiter(msg);
      else q[theirs].push(msg);
    },
    receive: async () =>
      q[mine].length ? q[mine].shift() : new Promise((res) => w[mine].push(res)),
  });
  return [make(0, 1), make(1, 0)];
}

describe('backend negotiation', () => {
  test('complementary bench roles engage optical on both sides', async () => {
    const [a, b] = channelPair();
    const [ra, rb] = await Promise.all([
      negotiateBackend(a, { backend: 'bench', role: 'source', isInitiator: true }),
      negotiateBackend(b, { backend: 'bench', role: 'detector', isInitiator: false }),
    ]);
    expect(ra.mode).toBe('optical');
    expect(rb.mode).toBe('optical');
    expect(ra.role).toBe('source');
    expect(rb.role).toBe('detector');
  });

  test('two source benches cannot pair — both fall back to sim', async () => {
    const [a, b] = channelPair();
    const [ra, rb] = await Promise.all([
      negotiateBackend(a, { backend: 'bench', role: 'source', isInitiator: true }),
      negotiateBackend(b, { backend: 'bench', role: 'source', isInitiator: false }),
    ]);
    expect(ra.mode).toBe('sim');
    expect(rb.mode).toBe('sim');
    // Physics roles re-derive from call topology in sim mode.
    expect(ra.role).toBe('source');
    expect(rb.role).toBe('detector');
  });

  test('one bench, one sim peer falls back to sim on both sides', async () => {
    const [a, b] = channelPair();
    const [ra, rb] = await Promise.all([
      negotiateBackend(a, { backend: 'bench', role: 'source', isInitiator: true }),
      negotiateBackend(b, { backend: 'sim', role: null, isInitiator: false }),
    ]);
    expect(ra.mode).toBe('sim');
    expect(rb.mode).toBe('sim');
  });

  test('a protocol-version mismatch falls back to sim', async () => {
    const [a, b] = channelPair();
    const rb = negotiateBackend(b, { backend: 'bench', role: 'detector', isInitiator: false });
    // Peer a (wired to b's inbox) speaks a future protocol version.
    await a.send({ type: 'backend-caps', backend: 'bench', role: 'source', protoV: PROTO_V + 1 });
    expect((await rb).mode).toBe('sim');
  });

  test('a malformed caps message is a hard error, not a silent fallback', async () => {
    const [a, b] = channelPair();
    const rb = negotiateBackend(b, { backend: 'bench', role: 'detector', isInitiator: false });
    // Feed b's negotiator (reads b's inbox) garbage from the a side.
    await a.send({ type: 'not-caps' });
    await expect(rb).rejects.toThrow(/malformed/);
  });
});
