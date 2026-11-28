/** Segundos até `untilMs`, arredondados para cima e nunca menos de 1: o `retryAfterSeconds` das recusas 429. */
export const secondsUntil = (untilMs: number, nowMs: number): number =>
  Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
