import { FLYER_PRO_LIMITS } from './flyer-pro.limits';

/** As regras de preço do protótipo (`frontend/.../productEdits.ts`), portadas: centavos inteiros de 1 a 9 999 999 (A-9). */

export type PriceIssueCode = 'PRICE_INVALID' | 'PRICE_FROM_NOT_GREATER' | 'PRICE_MULTI_BUY_INVALID';

type Price = Record<string, unknown>;
type PriceRule = (price: Price) => PriceIssueCode | null;

const isMoney = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= FLYER_PRO_LIMITS.priceMaxCents;

const SECOND_LABELS: readonly unknown[] = ['No cartão', 'Clube'];

const PRICE_RULES: Record<string, PriceRule> = {
  simple: () => null,
  from_to: (price) => {
    if (!isMoney(price.fromCents)) return 'PRICE_INVALID';
    return price.fromCents > (price.cents as number) ? null : 'PRICE_FROM_NOT_GREATER';
  },
  second_price: (price) =>
    isMoney(price.secondCents) && SECOND_LABELS.includes(price.secondLabel)
      ? null
      : 'PRICE_INVALID',
  per_kg_ref: (price) => (isMoney(price.refKgCents) ? null : 'PRICE_INVALID'),
  multi_buy: (price) => {
    const { buy, pay } = price;
    const whole = Number.isInteger(buy) && Number.isInteger(pay);
    return whole && (pay as number) >= 1 && (buy as number) > (pay as number)
      ? null
      : 'PRICE_MULTI_BUY_INVALID';
  },
};

/** O problema do preço (um código só, o primeiro), ou `null` quando ele passa. Tipo desconhecido é `PRICE_INVALID`. */
export function priceIssueCode(price: Price): PriceIssueCode | null {
  const rule = Object.prototype.hasOwnProperty.call(PRICE_RULES, String(price.kind))
    ? PRICE_RULES[String(price.kind)]
    : undefined;
  if (!rule || !isMoney(price.cents)) return 'PRICE_INVALID';
  return rule(price);
}
