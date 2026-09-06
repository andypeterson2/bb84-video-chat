/**
 * Backend capability negotiation.
 *
 * Runs once per call, right after fingerprint verification, over its own
 * authenticated one-shot channel (MAC domain 'nego'). Optical mode engages
 * only when BOTH peers report a bench backend with complementary physics
 * roles; anything else falls back to the simulated backend with a visible
 * notice — never silently, and never one-sided.
 */

export const PROTO_V = 1;

/**
 * @param {{send: Function, receive: Function}} channel - authenticated one-shot
 * @param {{backend: 'bench'|'sim', role: 'source'|'detector'|null, isInitiator: boolean}} self
 * @returns {Promise<{mode: 'optical'|'sim', role: 'source'|'detector', peer: object}>}
 *   role is this side's resolved PHYSICS role (in sim mode: initiator=source).
 */
export async function negotiateBackend(channel, { backend, role, isInitiator }) {
  await channel.send({ type: 'backend-caps', backend, role, protoV: PROTO_V });
  const peer = await channel.receive();
  if (!peer || peer.type !== 'backend-caps' || !Number.isInteger(peer.protoV)) {
    throw new Error('malformed backend-caps message');
  }
  const optical =
    backend === 'bench' &&
    peer.backend === 'bench' &&
    peer.protoV === PROTO_V &&
    ((role === 'source' && peer.role === 'detector') ||
      (role === 'detector' && peer.role === 'source'));
  if (optical) return { mode: 'optical', role, peer };
  // Simulated fallback: physics roles re-derive from the call topology.
  return { mode: 'sim', role: isInitiator ? 'source' : 'detector', peer };
}
