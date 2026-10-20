import { describe, expect, it } from 'vitest';
import { estimateBroadcastCost, parseBroadcastRate } from './broadcast-cost';

describe('per-college broadcast rate', () => {
  it('rejects invalid or negative rate entries', () => {
    for (const rate of ['', '-1', 'NaN', 'Infinity', '1e3', '100000', '1.12345', '1,000']) {
      expect(parseBroadcastRate(rate)).toBeNull();
    }
  });
  it('accepts configured zero and decimal rates', () => {
    expect(parseBroadcastRate('0')).toBe(0);
    expect(parseBroadcastRate(' 2.3456 ')).toBe(2.3456);
  });
  it('does not treat an unconfigured rate as free', () => {
    expect(estimateBroadcastCost(150000, null)).toBeNull();
  });
  it('estimates cost and rounds to paisa', () => {
    expect(estimateBroadcastCost(150000, 1.25)).toBe(187500);
    expect(estimateBroadcastCost(3, 1.2345)).toBe(3.70);
  });
  it('rejects impossible inputs', () => {
    expect(() => estimateBroadcastCost(-1, 2)).toThrow(RangeError);
    expect(() => estimateBroadcastCost(1.3, 2)).toThrow(RangeError);
  });
});
