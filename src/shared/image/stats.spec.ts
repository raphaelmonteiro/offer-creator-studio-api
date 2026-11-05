import { percentile } from './stats';

describe('percentile', () => {
  it('interpola linearmente', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([0, 10], 0.95)).toBeCloseTo(9.5, 6);
    expect(percentile([5, 1, 3], 0)).toBe(1);
  });

  it('lista vazia vale 0', () => {
    expect(percentile([], 0.9)).toBe(0);
  });
});
