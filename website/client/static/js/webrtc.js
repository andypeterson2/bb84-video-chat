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

/** Default capture constraints — real values, not bare booleans. `ideal` (not
 * `exact`) so a camera that can't do 1080p falls back gracefully instead of
 * failing getUserMedia; the QualityController lowers the live resolution. */
const DEFAULT_MEDIA_CONSTRAINTS = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** Encoder ceiling for the video sender; the QualityController lowers it. This
 * is a CEILING, not a target — GCC/TWCC still throttles the real send rate to
 * the measured pipe, so a high ceiling costs nothing on a constrained link and
 * unlocks full 1080p throughput on a fat one. */
const DEFAULT_MAX_BITRATE = 6_000_000;

/** Grace before an ICE `disconnected` (a transient blip) triggers a restart. */
const ICE_DISCONNECT_GRACE_MS = 3000;

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
    this._videoSender = null;
    this._reconnectTimer = null;
    this._restarting = false;

    this._bindSignaling();
  }

  /* ── Public API ──────────────────────────────────────────────── */

  /**
   * Get local media stream (camera + microphone).
   * @returns {Promise<MediaStream>}
   */
  async getLocalMedia(constraints = DEFAULT_MEDIA_CONSTRAINTS) {
    this._localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return this._localStream;
  }

  /** The active RTCPeerConnection (for the QualityController's getStats). */
  get peerConnection() {
    return this._pc;
  }

  /** The video RTCRtpSender (for adaptive encoder bitrate). */
  get videoSender() {
    return this._videoSender;
  }

  /**
   * DTLS certificate fingerprints from the negotiated SDP — the identities
   * the channel-auth layer binds into the MAC'd transcript and the SAS.
   * @returns {{local: string|null, remote: string|null}}
   */
  getDtlsFingerprints() {
    const grab = (desc) => {
      const match =
        desc && desc.sdp ? desc.sdp.match(/^a=fingerprint:sha-256 ([0-9A-F:]+)/im) : null;
      return match ? match[1].toUpperCase() : null;
    };
    return {
      local: grab(this._pc && this._pc.localDescription),
      remote: grab(this._pc && this._pc.remoteDescription),
    };
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
    // Without RTCRtpScriptTransform there is no transform to key: posting
    // set-key would flip the UI to "encrypted" while media flows in the clear.
    if (this._transformsUnsupported) return;
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
  get roomId() {
    return this._roomId;
  }

  /** Get the local MediaStream. */
  get localStream() {
    return this._localStream;
  }

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
      // Mid-call offer handling. The ONLY legitimate mid-call offer is an ICE
      // restart, and it is applied to the EXISTING peer connection — reusing its
      // senders, encoded-transform, and keyed crypto worker — so the fail-closed
      // key is preserved and the worker is never rebuilt keyless. Any other
      // mid-call offer is the downgrade the guard exists to reject: an
      // unflagged offer would silently rebuild the connection with a fresh
      // keyless worker, flowing plaintext while the UI still said encrypted.
      if (this._pc) {
        if (data.iceRestart && data.sdp) {
          try {
            await this._pc.setRemoteDescription(data.sdp);
            const answer = await this._pc.createAnswer();
            await this._pc.setLocalDescription(answer);
            this._socket.emit('answer', { sdp: this._pc.localDescription });
          } catch (e) {
            console.warn('Failed to apply ICE-restart offer:', e);
          }
          return;
        }
        console.warn('Ignoring unexpected mid-call SDP offer (renegotiation is not supported)');
        this._emit('error', { message: 'unexpected renegotiation offer ignored' });
        return;
      }
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

    // The answerer nudges the initiator to restart ICE if it noticed the
    // failure first; only the initiator ever generates the restart offer (no
    // glare). A stale nudge after teardown is harmless — no _pc, no-op.
    this._socket.on('request-ice-restart', () => {
      if (this._isInitiator) this._restartIce();
    });

    this._socket.on('error', (data) => {
      this._emit('error', data);
    });
  }

  /* ── Peer Connection ─────────────────────────────────────────── */

  async _createPeerConnection() {
    this._pc = new RTCPeerConnection({
      iceServers: this._iceServers,
      bundlePolicy: 'max-bundle',
      // Warm a few candidates so the offer already carries them (lower setup
      // latency); harmless when TURN isn't configured.
      iceCandidatePoolSize: 4,
    });

    this._pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._socket.emit('ice_candidate', { candidate: event.candidate });
      }
    };

    this._pc.oniceconnectionstatechange = () => {
      const st = this._pc.iceConnectionState;
      this._emit('state-change', { state: st });
      this._maybeReconnect(st);
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
      // Probe transform support before anything else: on a browser without
      // RTCRtpScriptTransform the sender/receiver transforms silently never
      // attach, so the pipeline would run UNENCRYPTED while the worker (and
      // pill) claim otherwise. Fail loudly instead and never accept a key.
      if (typeof RTCRtpScriptTransform === 'undefined') {
        this._transformsUnsupported = true;
        this._emit('cipher-state', { state: 'unsupported' });
        return;
      }
      if (this._encryptWorker) this._encryptWorker.terminate();
      // Relative to this module (static/js/), so it resolves under any deploy
      // root — the old absolute '/js/…' 404'd on the Pages deployment, and a
      // Worker 404 fails silently: encryption never engaged.
      this._encryptWorker = new Worker(new URL('./crypto-worker.js', import.meta.url), {
        type: 'module',
      });
      this._encryptWorker.onerror = (e) => {
        this._emit('cipher-state', { state: 'worker-error', error: String(e.message || e) });
      };
      this._encryptWorker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'cipher-state') this._emit('cipher-state', msg);
        else if (msg.type === 'decrypt-error') this._emit('decrypt-error', msg);
        else if (msg.type === 'metrics') this._emit('crypto-metrics', msg);
      };
    }
  }

  _addLocalTracks() {
    if (!this._localStream || !this._pc) return;
    for (const track of this._localStream.getTracks()) {
      const sender = this._pc.addTrack(track, this._localStream);
      if (this._enableEncryption) {
        this._applyEncryptTransform(sender);
      }
      if (track.kind === 'video') {
        this._videoSender = sender;
        this._applyEncoderParams(sender);
      }
    }
  }

  /**
   * Encoder ceiling + graceful-degradation hints on the video sender. `L1T3`
   * temporal scalability keeps a valid lower-frame-rate picture when upper
   * temporal layers are lost, and lets the encoder shed a layer on a bandwidth
   * drop without a keyframe. Best-effort — unsupported options just don't apply;
   * the QualityController later lowers `maxBitrate` from live stats.
   * @private
   */
  _applyEncoderParams(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = DEFAULT_MAX_BITRATE;
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scalabilityMode = 'L1T3';
      params.degradationPreference = 'balanced';
      sender.setParameters(params).catch(() => {});
    } catch {
      /* setParameters shape not ready / unsupported — encoder uses defaults */
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

  /* ── Reconnection (ICE restart) ──────────────────────────────── */

  /**
   * React to an ICE connection state change. `failed` restarts immediately;
   * `disconnected` (often a transient blip) waits a short grace before
   * restarting and is cancelled if the connection recovers. The initiator
   * generates the restart offer; the answerer nudges it instead (no glare).
   * Reconnection reuses the EXISTING peer connection, so the fail-closed
   * encryption key is preserved throughout.
   * @private
   */
  _maybeReconnect(state) {
    if (state === 'connected' || state === 'completed') {
      this._clearReconnectTimer();
    } else if (state === 'failed') {
      this._clearReconnectTimer();
      this._triggerReconnect();
    } else if (state === 'disconnected' && !this._reconnectTimer) {
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        const st = this._pc && this._pc.iceConnectionState;
        if (st === 'disconnected' || st === 'failed') this._triggerReconnect();
      }, ICE_DISCONNECT_GRACE_MS);
    }
  }

  /** @private initiator restarts ICE; answerer asks the initiator to. */
  _triggerReconnect() {
    if (!this._pc) return;
    if (this._isInitiator) this._restartIce();
    else this._socket.emit('request_ice_restart');
  }

  /**
   * Regenerate ICE credentials on the EXISTING peer connection and re-offer,
   * flagged so the peer applies it in place. Never rebuilds the connection or
   * the crypto worker, so the key survives the reconnection.
   * @private
   */
  async _restartIce() {
    if (!this._pc || !this._isInitiator || this._restarting) return;
    this._restarting = true;
    try {
      const offer = await this._pc.createOffer({ iceRestart: true });
      await this._pc.setLocalDescription(offer);
      this._socket.emit('offer', { sdp: this._pc.localDescription, iceRestart: true });
    } catch (e) {
      console.warn('ICE restart failed:', e);
    } finally {
      this._restarting = false;
    }
  }

  /** @private */
  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
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
    this._clearReconnectTimer();
    this._videoSender = null;
    this._restarting = false;
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
