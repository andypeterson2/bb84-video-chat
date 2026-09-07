/**
 * QualityController — adaptive video quality based on network conditions.
 *
 * Polls RTCPeerConnection.getStats() and drives adaptation off the browser's
 * OWN bandwidth estimate (`availableOutgoingBitrate`, the GCC/TWCC output) when
 * present — don't rebuild BWE, cooperate with it. It selects a quality tier,
 * caps the encoder via the video sender's `maxBitrate`, and applies capture
 * constraints to the local track. Falls back to a bytesSent-delta estimate when
 * `availableOutgoingBitrate` is unavailable.
 */

const POLL_INTERVAL_MS = 2000;
const HYSTERESIS_COUNT = 3;

const TIERS = [
  { label: 'Full HD', minKbps: 4000, targetKbps: 6000, width: 1920, height: 1080, fps: 30 },
  { label: 'HD', minKbps: 2500, targetKbps: 2500, width: 1280, height: 720, fps: 30 },
  { label: 'SD', minKbps: 1000, targetKbps: 1200, width: 640, height: 480, fps: 30 },
  { label: 'SD Low', minKbps: 500, targetKbps: 700, width: 640, height: 480, fps: 15 },
  { label: 'Low', minKbps: 200, targetKbps: 400, width: 320, height: 240, fps: 15 },
  { label: 'Min', minKbps: 0, targetKbps: 250, width: 320, height: 240, fps: 10 },
];

export class QualityController {
  /**
   * @param {object} options
   * @param {RTCPeerConnection} options.pc
   * @param {MediaStream} options.localStream
   * @param {RTCRtpSender} [options.sender] - video sender, for maxBitrate control
   * @param {function(object): void} options.onUpdate
   */
  constructor({ pc, localStream, sender, onUpdate }) {
    this._pc = pc;
    this._localStream = localStream;
    this._sender = sender || null;
    this._onUpdate = onUpdate;
    this._intervalId = null;
    this._prevBytesSent = null;
    this._prevTimestamp = null;
    // Start at the top tier and DOWNSHIFT on evidence, rather than climbing up
    // from SD (which left a fat link at SD for the ~6s the up-shift hysteresis
    // takes). The high encoder ceiling is GCC-throttled, so an over-optimistic
    // start self-corrects within the first few polls on a constrained link.
    this._currentTier = TIERS[0];
    this._pendingTier = null;
    this._pendingCount = 0;
  }

  start() {
    this.stop();
    this._poll();
    this._intervalId = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._prevBytesSent = null;
    this._prevTimestamp = null;
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity -- grandfathered at 23; the stats poller branches per metric — split when next touched
  async _poll() {
    if (!this._pc) return;

    let stats;
    try {
      stats = await this._pc.getStats();
    } catch {
      return;
    }

    let rttMs = null;
    let outboundVideo = null;
    let inboundVideo = null;
    let availableKbps = null;

    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.nominated) {
        rttMs =
          report.currentRoundTripTime != null
            ? Math.round(report.currentRoundTripTime * 1000)
            : null;
        // The browser's own send-side estimate (GCC/TWCC), in bits/s.
        if (report.availableOutgoingBitrate != null) {
          availableKbps = Math.round(report.availableOutgoingBitrate / 1000);
        }
      }
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        outboundVideo = report;
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        inboundVideo = report;
      }
    });

    // Prefer the browser's own bandwidth estimate; fall back to a send-rate
    // delta only when availableOutgoingBitrate isn't exposed.
    let bandwidthKbps = availableKbps;
    const now = performance.now();
    if (bandwidthKbps == null && outboundVideo && this._prevBytesSent != null) {
      const deltaBytes = outboundVideo.bytesSent - this._prevBytesSent;
      const deltaSec = (now - this._prevTimestamp) / 1000;
      if (deltaSec > 0) {
        bandwidthKbps = Math.round((deltaBytes * 8) / deltaSec / 1000);
      }
    }
    if (outboundVideo) {
      this._prevBytesSent = outboundVideo.bytesSent;
      this._prevTimestamp = now;
    }

    // Select tier with hysteresis
    if (bandwidthKbps != null) {
      const idealTier = TIERS.find((t) => bandwidthKbps >= t.minKbps) || TIERS[TIERS.length - 1];
      if (idealTier !== this._currentTier) {
        if (idealTier === this._pendingTier) {
          this._pendingCount++;
          if (this._pendingCount >= HYSTERESIS_COUNT) {
            this._currentTier = idealTier;
            this._pendingTier = null;
            this._pendingCount = 0;
            this._applyConstraints();
            this._applyBitrate();
          }
        } else {
          this._pendingTier = idealTier;
          this._pendingCount = 1;
        }
      } else {
        this._pendingTier = null;
        this._pendingCount = 0;
      }
    }

    // Gather actual values
    const actualFps = outboundVideo?.framesPerSecond ?? null;
    const actualWidth = outboundVideo?.frameWidth ?? null;
    const actualHeight = outboundVideo?.frameHeight ?? null;
    const inFps = inboundVideo?.framesPerSecond ?? null;
    const inWidth = inboundVideo?.frameWidth ?? null;
    const inHeight = inboundVideo?.frameHeight ?? null;
    // Why the browser is holding quality back: 'bandwidth' | 'cpu' | 'none'.
    const limitedBy = outboundVideo?.qualityLimitationReason ?? null;

    this._onUpdate({
      rttMs,
      bandwidthKbps,
      tier: this._currentTier.label,
      targetFps: this._currentTier.fps,
      targetRes: this._currentTier.height + 'p',
      actualFps,
      actualRes: actualWidth && actualHeight ? actualWidth + 'x' + actualHeight : null,
      inFps,
      inRes: inWidth && inHeight ? inWidth + 'x' + inHeight : null,
      limitedBy,
    });
  }

  /** Cap the encoder at the current tier's target bitrate. @private */
  _applyBitrate() {
    if (!this._sender) return;
    try {
      const params = this._sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = this._currentTier.targetKbps * 1000;
      this._sender.setParameters(params).catch(() => {});
    } catch {
      /* sender params not settable here — resolution ladder still applies */
    }
  }

  _applyConstraints() {
    const track = this._localStream?.getVideoTracks()[0];
    if (!track) return;
    track
      .applyConstraints({
        width: { ideal: this._currentTier.width },
        height: { ideal: this._currentTier.height },
        frameRate: { ideal: this._currentTier.fps },
      })
      .catch(() => {});
  }
}
