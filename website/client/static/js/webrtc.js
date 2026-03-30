/**
 * WebRTCManager — manages RTCPeerConnection lifecycle, media tracks,
 * Insertable Streams transforms, and DataChannels.
 *
 * Connects to the signaling server via Socket.IO, handles SDP exchange
 * and ICE candidate relay, and provides events for connection state changes.
 *
 * @fires WebRTCManager#state-change
 * @fires WebRTCManager#remote-stream
 * @fires WebRTCManager#data-channel-open
 * @fires WebRTCManager#data-channel-message
 */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export class WebRTCManager {
  /**
   * @param {object} socket - Socket.IO client instance (for signaling).
   * @param {object} [options]
   * @param {Array} [options.iceServers] - ICE server configuration.
   * @param {boolean} [options.enableEncryption] - Whether to apply Insertable Streams transforms.
   */
  constructor(socket, options = {}) {
    this._socket = socket;
    this._iceServers = options.iceServers || ICE_SERVERS;
    this._enableEncryption = options.enableEncryption ?? false;
    this._pc = null;
    this._localStream = null;
    this._dataChannel = null;
    this._encryptWorker = null;
    this._listeners = {};
    this._isInitiator = false;
    this._roomId = null;

    this._bindSignaling();
  }

  /* ── Public API ──────────────────────────────────────────────── */

  /**
   * Get local media stream (camera + microphone).
   * @returns {Promise<MediaStream>}
   */
  async getLocalMedia(constraints = { video: true, audio: true }) {
    this._localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return this._localStream;
  }

  /**
   * Create a room on the signaling server.
   */
  createRoom() {
    this._socket.emit('create_room');
  }

  /**
   * Join an existing room.
   * @param {string} roomId
   */
  joinRoom(roomId) {
    this._socket.emit('join_room', { room_id: roomId });
  }

  /**
   * Leave the current room and close the peer connection.
   */
  leave() {
    this._socket.emit('leave_room');
    this._cleanup();
  }

  /**
   * Send a message over the data channel.
   * @param {string|ArrayBuffer} data
   */
  sendData(data) {
    if (this._dataChannel && this._dataChannel.readyState === 'open') {
      this._dataChannel.send(data);
    }
  }

  /**
   * Set the encryption key for Insertable Streams.
   * Posts the key to the crypto worker.
   * @param {Uint8Array} rawKey - 16-byte AES key.
   * @param {number} keyIndex - Key rotation index.
   */
  setEncryptionKey(rawKey, keyIndex) {
    if (this._encryptWorker) {
      this._encryptWorker.postMessage({ type: 'set-key', rawKey, keyIndex });
    }
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  /** Get the current room ID. */
  get roomId() { return this._roomId; }

  /** Get the local MediaStream. */
  get localStream() { return this._localStream; }

  /* ── Signaling ───────────────────────────────────────────────── */

  _bindSignaling() {
    this._socket.on('room-created', (data) => {
      this._roomId = data.room_id;
      this._emit('room-created', data);
    });

    this._socket.on('room-joined', async (data) => {
      this._roomId = data.room_id;
      this._isInitiator = data.initiator;
      this._emit('room-joined', data);

      // Initiator creates and sends the offer
      if (this._isInitiator) {
        await this._createPeerConnection();
        this._createDataChannel();
        this._addLocalTracks();
        const offer = await this._pc.createOffer();
        await this._pc.setLocalDescription(offer);
        this._socket.emit('offer', { sdp: this._pc.localDescription });
      }
    });

    this._socket.on('offer', async (data) => {
      // Non-initiator receives offer, creates answer
      await this._createPeerConnection();
      this._addLocalTracks();
      await this._pc.setRemoteDescription(data.sdp);
      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);
      this._socket.emit('answer', { sdp: this._pc.localDescription });
    });

    this._socket.on('answer', async (data) => {
      if (this._pc) {
        await this._pc.setRemoteDescription(data.sdp);
      }
    });

    this._socket.on('ice-candidate', async (data) => {
      if (this._pc && data.candidate) {
        try {
          await this._pc.addIceCandidate(data.candidate);
        } catch (e) {
          console.warn('Failed to add ICE candidate:', e);
        }
      }
    });

    this._socket.on('peer-disconnected', () => {
      this._cleanup();
      this._emit('peer-disconnected');
    });

    this._socket.on('error', (data) => {
      this._emit('error', data);
    });
  }

  /* ── Peer Connection ─────────────────────────────────────────── */

  async _createPeerConnection() {
    this._pc = new RTCPeerConnection({ iceServers: this._iceServers });

    this._pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._socket.emit('ice_candidate', { candidate: event.candidate });
      }
    };

    this._pc.oniceconnectionstatechange = () => {
      this._emit('state-change', { state: this._pc.iceConnectionState });
    };

    this._pc.ontrack = (event) => {
      this._emit('remote-stream', { stream: event.streams[0] });
      // Apply decryption transform if encryption is enabled
      if (this._enableEncryption && event.receiver) {
        this._applyDecryptTransform(event.receiver);
      }
    };

    this._pc.ondatachannel = (event) => {
      this._setupDataChannel(event.channel);
    };

    // Set up encryption worker if needed
    if (this._enableEncryption) {
      this._encryptWorker = new Worker('/js/crypto-worker.js', { type: 'module' });
    }
  }

  _addLocalTracks() {
    if (!this._localStream || !this._pc) return;
    for (const track of this._localStream.getTracks()) {
      const sender = this._pc.addTrack(track, this._localStream);
      if (this._enableEncryption) {
        this._applyEncryptTransform(sender);
      }
    }
  }

  _createDataChannel() {
    if (!this._pc) return;
    const channel = this._pc.createDataChannel('qkd', {
      ordered: true,
    });
    this._setupDataChannel(channel);
  }

  _setupDataChannel(channel) {
    this._dataChannel = channel;
    channel.onopen = () => this._emit('data-channel-open');
    channel.onmessage = (event) => this._emit('data-channel-message', event.data);
    channel.onclose = () => this._emit('data-channel-close');
  }

  /* ── Insertable Streams (Encoded Transforms) ─────────────────── */

  _applyEncryptTransform(sender) {
    if (!sender.transform && typeof RTCRtpScriptTransform !== 'undefined') {
      sender.transform = new RTCRtpScriptTransform(this._encryptWorker, {
        operation: 'encrypt',
      });
    }
  }

  _applyDecryptTransform(receiver) {
    if (!receiver.transform && typeof RTCRtpScriptTransform !== 'undefined') {
      receiver.transform = new RTCRtpScriptTransform(this._encryptWorker, {
        operation: 'decrypt',
      });
    }
  }

  /* ── Cleanup ─────────────────────────────────────────────────── */

  _cleanup() {
    if (this._pc) {
      this._pc.close();
      this._pc = null;
    }
    if (this._dataChannel) {
      this._dataChannel.close();
      this._dataChannel = null;
    }
    if (this._encryptWorker) {
      this._encryptWorker.terminate();
      this._encryptWorker = null;
    }
    this._roomId = null;
    this._isInitiator = false;
  }

  /* ── Event Emitter ───────────────────────────────────────────── */

  _emit(event, data) {
    const cbs = this._listeners[event];
    if (cbs) cbs.forEach((cb) => cb(data));
  }
}
