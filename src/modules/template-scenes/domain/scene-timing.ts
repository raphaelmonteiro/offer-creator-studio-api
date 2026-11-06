/** Custo em USD com 6 casas, como gravado em `providerCostUsd` e `totalCostUsd`. */
export const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/** Resolve `'timeout'` depois de `ms`: corre contra a chamada paga (Diretor e juiz) para limitar o tempo. */
export const sleepFor = (ms: number): Promise<'timeout'> =>
  new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
