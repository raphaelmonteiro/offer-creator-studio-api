import { percentile } from '../../src/modules/commercials/domain/mc-jump-metric';

export const median = (values: number[]): number => percentile(values, 0.5);
export const p90 = (values: number[]): number => percentile(values, 0.9);

export interface Summary {
  n: number;
  median: number;
  p90: number;
}

export function summarize(values: number[]): Summary {
  return { n: values.length, median: median(values), p90: p90(values) };
}
