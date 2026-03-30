/**
 * SignalingClient — thin wrapper around Socket.IO for WebRTC signaling.
 *
 * Emits and listens for signaling events: room management, SDP exchange,
 * ICE candidates, and peer lifecycle. Does NOT handle media or encryption.
 *
 * Events emitted to server:
 *   create_room, join_room, leave_room, offer, answer, ice_candidate
 *
 * Events received from server:
 *   welcome, room-created, room-joined, peer-disconnected,
 *   offer, answer, ice-candidate, error, disconnect
 */

const RELAYED_EVENTS = [
  'welcome',
  'room-created',
  'room-joined',
  'peer-disconnected',
  'offer',
  'answer',
  'ice-candidate',
  'error',
  'disconnect',
];

export class SignalingClient {
  /**
   * @param {object} socket - Socket.IO client instance.
   */
  constructor(socket) {
    /** @private */
    this._socket = socket;
    /** @private @type {Map<string, Set<Function>>} */
    this._listeners = new Map();

    this._bindSocketEvents();
  }

  /* ── Outgoing (browser → signaling server) ────────────────────── */

  /** Create a new room (caller becomes first peer). */
  createRoom() {
    this._socket.emit('create_room');
  }

  /**
   * Join an existing room by ID.
   * @param {string} roomId - 5-character room code.
   */
  joinRoom(roomId) {
    this._socket.emit('join_room', { room_id: roomId });
  }

  /** Leave the current room. */
  leave() {
    this._socket.emit('leave_room');
  }

  /**
   * Send an SDP offer to the peer via the signaling server.
   * @param {RTCSessionDescription} sdp
   */
  sendOffer(sdp) {
    this._socket.emit('offer', { sdp });
  }

  /**
   * Send an SDP answer to the peer via the signaling server.
   * @param {RTCSessionDescription} sdp
   */
  sendAnswer(sdp) {
    this._socket.emit('answer', { sdp });
  }

  /**
   * Send an ICE candidate to the peer via the signaling server.
   * @param {RTCIceCandidate} candidate
   */
  sendIceCandidate(candidate) {
    this._socket.emit('ice_candidate', { candidate });
  }

  /* ── Event subscription ───────────────────────────────────────── */

  /**
   * Subscribe to a signaling event.
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
  }

  /**
   * Unsubscribe from a signaling event.
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const subs = this._listeners.get(event);
    if (subs) subs.delete(callback);
  }

  /* ── Internal ─────────────────────────────────────────────────── */

  /** @private */
  _bindSocketEvents() {
    for (const event of RELAYED_EVENTS) {
      this._socket.on(event, (data) => this._emit(event, data));
    }
  }

  /** @private */
  _emit(event, data) {
    const subs = this._listeners.get(event);
    if (!subs) return;
    for (const cb of subs) {
      cb(data);
    }
  }
}
