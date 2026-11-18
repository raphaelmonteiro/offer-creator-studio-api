import { priceIssueCode } from './flyer-pro-price-rules';

/** Os casos de `frontend/src/utils/flyerProPrototype/productEdits.test.ts` (preço, I-26), reproduzidos: A-9 e R20. */
const simple = (cents: number) => ({ kind: 'simple', cents });

describe('priceIssueCode (as regras de preço do protótipo)', () => {
  it('simples: de 1 a 9 999 999 centavos, inteiro', () => {
    expect(priceIssueCode(simple(999))).toBeNull();
    expect(priceIssueCode(simple(1))).toBeNull();
    expect(priceIssueCode(simple(9_999_999))).toBeNull();
    for (const cents of [0, -1, 1.5, 10_000_000]) {
      expect(priceIssueCode(simple(cents))).toBe('PRICE_INVALID');
    }
    expect(priceIssueCode({ kind: 'simple' })).toBe('PRICE_INVALID');
    expect(priceIssueCode({ kind: 'simple', cents: '699' })).toBe('PRICE_INVALID');
  });

  it('de/por: "de" maior que "por"; igual ou menor é PRICE_FROM_NOT_GREATER; sem "de" é PRICE_INVALID', () => {
    expect(priceIssueCode({ kind: 'from_to', cents: 999, fromCents: 1299 })).toBeNull();
    expect(priceIssueCode({ kind: 'from_to', cents: 3990, fromCents: 4990 })).toBeNull();
    expect(priceIssueCode({ kind: 'from_to', cents: 999, fromCents: 999 })).toBe(
      'PRICE_FROM_NOT_GREATER',
    );
    expect(priceIssueCode({ kind: 'from_to', cents: 4990, fromCents: 3990 })).toBe(
      'PRICE_FROM_NOT_GREATER',
    );
    expect(priceIssueCode({ kind: 'from_to', cents: 999 })).toBe('PRICE_INVALID');
    expect(priceIssueCode({ kind: 'from_to', cents: 999, fromCents: 0 })).toBe('PRICE_INVALID');
  });

  it('segundo preço: valor positivo e rótulo "No cartão" ou "Clube"', () => {
    const base = { kind: 'second_price', cents: 999, secondCents: 899 };
    expect(priceIssueCode({ ...base, secondLabel: 'Clube' })).toBeNull();
    expect(priceIssueCode({ ...base, secondLabel: 'No cartão' })).toBeNull();
    expect(priceIssueCode({ ...base, secondCents: 0, secondLabel: 'Clube' })).toBe('PRICE_INVALID');
    expect(priceIssueCode({ kind: 'second_price', cents: 999, secondLabel: 'Clube' })).toBe(
      'PRICE_INVALID',
    );
    expect(priceIssueCode(base)).toBe('PRICE_INVALID');
    expect(priceIssueCode({ ...base, secondLabel: 'Fidelidade' })).toBe('PRICE_INVALID');
  });

  it('preço do kg: valor positivo', () => {
    expect(priceIssueCode({ kind: 'per_kg_ref', cents: 443, refKgCents: 1483 })).toBeNull();
    expect(priceIssueCode({ kind: 'per_kg_ref', cents: 443 })).toBe('PRICE_INVALID');
  });

  it('leve X pague Y: inteiros, pague pelo menos 1 e leve maior que pague', () => {
    expect(priceIssueCode({ kind: 'multi_buy', cents: 249, buy: 6, pay: 5 })).toBeNull();
    expect(priceIssueCode({ kind: 'multi_buy', cents: 899, buy: 3, pay: 2 })).toBeNull();
    for (const [buy, pay] of [
      [5, 5],
      [2, 3],
      [3, 0],
      [2.5, 1],
      [3, 1.5],
    ]) {
      expect(priceIssueCode({ kind: 'multi_buy', cents: 249, buy, pay })).toBe(
        'PRICE_MULTI_BUY_INVALID',
      );
    }
    expect(priceIssueCode({ kind: 'multi_buy', cents: 249 })).toBe('PRICE_MULTI_BUY_INVALID');
  });

  it('tipo desconhecido, ausente ou herdado do Object é PRICE_INVALID', () => {
    expect(priceIssueCode({ kind: 'combo', cents: 100 })).toBe('PRICE_INVALID');
    expect(priceIssueCode({ cents: 100 })).toBe('PRICE_INVALID');
    expect(priceIssueCode({ kind: 'constructor', cents: 100 })).toBe('PRICE_INVALID');
  });

  it('os cinco tipos de preço válidos passam', () => {
    const prices = [
      simple(699),
      { kind: 'from_to', cents: 3990, fromCents: 4990 },
      { kind: 'second_price', cents: 1199, secondCents: 999, secondLabel: 'Clube' },
      { kind: 'per_kg_ref', cents: 2490, refKgCents: 4980 },
      { kind: 'multi_buy', cents: 899, buy: 3, pay: 2 },
    ];
    expect(prices.map(priceIssueCode)).toEqual([null, null, null, null, null]);
  });
});
