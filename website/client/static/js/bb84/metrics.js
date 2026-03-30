/**
 * BB84Metrics — simple data class for BB84 round metrics.
 */
export class BB84Metrics {
  constructor() {
    this.rawBits = 0;
    this.siftedBits = 0;
    this.qber = 0;
    this.keyLength = 0;
    this.roundDurationMs = 0;
    this.siftingEfficiency = 0;
    this.isSecure = false;
  }
}
