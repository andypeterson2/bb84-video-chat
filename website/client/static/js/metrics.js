/**
 * MetricsCollector — aggregates real-time metrics from encryption worker and BB84.
 *
 * Accepts metric samples, maintains rolling windows, evaluates thresholds,
 * and dispatches events to subscribers.
 */

export class MetricsCollector {
  constructor(options = {}) {
    this._windowSize = options.windowSize ?? 60;
    this._keyBudgetLowWatermark = options.keyBudgetLowWatermark ?? 1024;
    this._qberThreshold = options.qberThreshold ?? 0.11;

    /** @type {Map<string, Array<number>>} */
    this._samples = new Map();

    /** @type {Map<string, Set<Function>>} */
    this._subscribers = new Map();

    // Track state for edge-triggered events
    this._qberExceeded = false;
    this._keyBudgetLow = false;
  }

  /**
   * Record a metric sample.
   * @param {string} name
   * @param {number} value
   */
  record(name, value) {
    if (!this._samples.has(name)) {
      this._samples.set(name, []);
    }
    const arr = this._samples.get(name);
    arr.push(value);
    if (arr.length > this._windowSize) {
      arr.shift();
    }
  }

  /**
   * Get the latest value for a metric.
   * @param {string} name
   * @returns {number|undefined}
   */
  get(name) {
    const arr = this._samples.get(name);
    if (!arr || arr.length === 0) return undefined;
    return arr[arr.length - 1];
  }

  /**
   * Get the last n samples of a metric.
   * @param {string} name
   * @param {number} n
   * @returns {Array<number>}
   */
  getHistory(name, n) {
    const arr = this._samples.get(name);
    if (!arr) return [];
    return arr.slice(-n);
  }

  /**
   * Subscribe to a threshold event.
   * @param {string} event - 'key-budget-low' | 'qber-exceeded' | 'qber-normal'
   * @param {Function} callback
   */
  subscribe(event, callback) {
    if (!this._subscribers.has(event)) {
      this._subscribers.set(event, new Set());
    }
    this._subscribers.get(event).add(callback);
  }

  /**
   * Unsubscribe from a threshold event.
   * @param {string} event
   * @param {Function} callback
   */
  unsubscribe(event, callback) {
    const subs = this._subscribers.get(event);
    if (subs) subs.delete(callback);
  }

  /**
   * Check thresholds and fire events.
   */
  evaluate() {
    const qber = this.get('qber');
    if (qber !== undefined) {
      if (qber > this._qberThreshold && !this._qberExceeded) {
        this._qberExceeded = true;
        this._emit('qber-exceeded', { value: qber });
      } else if (qber <= this._qberThreshold && this._qberExceeded) {
        this._qberExceeded = false;
        this._emit('qber-normal', { value: qber });
      }
    }

    const keyBudget = this.get('keyBudget');
    if (keyBudget !== undefined) {
      if (keyBudget < this._keyBudgetLowWatermark && !this._keyBudgetLow) {
        this._keyBudgetLow = true;
        this._emit('key-budget-low', { value: keyBudget });
      } else if (keyBudget >= this._keyBudgetLowWatermark && this._keyBudgetLow) {
        this._keyBudgetLow = false;
      }
    }
  }

  /** @private */
  _emit(event, data) {
    const subs = this._subscribers.get(event);
    if (!subs) return;
    for (const cb of subs) {
      cb(data);
    }
  }
}
