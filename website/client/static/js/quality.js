/**
 * QualityController — adaptive video quality based on network conditions.
 *
 * Polls RTCPeerConnection.getStats() to measure bandwidth and RTT,
 * selects a quality tier, and applies constraints to the local video track.
 */

const POLL_INTERVAL_MS = 2000;
const HYSTERESIS_COUNT = 3;

const TIERS = [
  { label: 'HD', minKbps: 2500, width: 1280, height: 720, fps: 30 },
  { label: 'SD', minKbps: 1000, width: 640, height: 480, fps: 30 },
  { label: 'SD Low', minKbps: 500, width: 640, height: 480, fps: 15 },
  { label: 'Low', minKbps: 200, width: 320, height: 240, fps: 15 },
  { label: 'Min', minKbps: 0, width: 320, height: 240, fps: 10 },
];

export class QualityController {
  /**
   * @param {object} options
   * @param {RTCPeerConnection} options.pc
   * @param {MediaStream} options.localStream
   * @param {function(object): void} options.onUpdate
   */
  constructor({ pc, localStream, onUpdate }) {
    this._pc = pc;
    this._localStream = localStream;
    this._onUpdate = onUpdate;
    this._intervalId = null;
    this._prevBytesSent = null;
    this._prevTimestamp = null;
    this._currentTier = TIERS[1]; // start at SD
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

    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && report.nominated) {
        rttMs =
          report.currentRoundTripTime != null
            ? Math.round(report.currentRoundTripTime * 1000)
            : null;
      }
      if (report.type === 'outbound-rtp' && report.kind === 'video') {
        outboundVideo = report;
      }
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        inboundVideo = report;
      }
    });

    // Calculate outbound bandwidth
    let bandwidthKbps = null;
    const now = performance.now();
    if (outboundVideo && this._prevBytesSent != null) {
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
    });
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
