import { vi } from 'vitest';
import { MetricsCollector } from '../../website/client/static/js/metrics.js';

describe('MetricsCollector', () => {
  let collector;

  beforeEach(() => {
    collector = new MetricsCollector({
      windowSize: 60,
      keyBudgetLowWatermark: 1024,
      qberThreshold: 0.11,
    });
  });

  test('record and retrieve a single metric', () => {
    collector.record('qber', 0.05);
    expect(collector.get('qber')).toBe(0.05);
  });

  test('getHistory returns correct rolling window', () => {
    for (let i = 0; i < 100; i++) {
      collector.record('qber', i);
    }
    const history = collector.getHistory('qber', 10);
    expect(history).toHaveLength(10);
    expect(history[0]).toBe(90);
    expect(history[9]).toBe(99);
  });

  test('qber exceeding threshold fires qber-exceeded event', () => {
    const callback = vi.fn();
    collector.subscribe('qber-exceeded', callback);

    collector.record('qber', 0.05);
    collector.evaluate();
    expect(callback).not.toHaveBeenCalled();

    collector.record('qber', 0.15);
    collector.evaluate();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ value: 0.15 }));
  });

  test('qber returning below threshold fires qber-normal event', () => {
    const callback = vi.fn();
    collector.subscribe('qber-normal', callback);

    // First push qber above threshold
    collector.record('qber', 0.15);
    collector.evaluate();

    // Now bring it back below
    collector.record('qber', 0.05);
    collector.evaluate();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ value: 0.05 }));
  });

  test('key budget below watermark fires key-budget-low event', () => {
    const callback = vi.fn();
    collector.subscribe('key-budget-low', callback);

    collector.record('keyBudget', 2048);
    collector.evaluate();
    expect(callback).not.toHaveBeenCalled();

    collector.record('keyBudget', 512);
    collector.evaluate();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ value: 512 }));
  });

  test('unsubscribe prevents callback', () => {
    const callback = vi.fn();
    collector.subscribe('qber-exceeded', callback);
    collector.unsubscribe('qber-exceeded', callback);

    collector.record('qber', 0.15);
    collector.evaluate();
    expect(callback).not.toHaveBeenCalled();
  });
});
