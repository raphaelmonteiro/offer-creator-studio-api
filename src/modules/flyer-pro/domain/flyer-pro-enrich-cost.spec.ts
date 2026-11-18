import { addCost, withCostMark } from './flyer-pro-enrich-cost';

const job = (costUsd: number | null, costUnknown?: true) => ({
  costUsd,
  cursor: { round: 1, pass: 0, position: null, id: null, ...(costUnknown ? { costUnknown } : {}) },
});

describe('custo do job (A-9)', () => {
  it('soma o custo de cada chamada, com seis casas', () => {
    expect(addCost(job(null), { costUsd: 0.0002 })).toEqual({ costUsd: 0.0002, unknown: false });
    expect(addCost(job(0.0002), { costUsd: 0.0001 })).toEqual({ costUsd: 0.0003, unknown: false });
    expect(addCost(job(0.1), { costUsd: 0.2 })).toEqual({ costUsd: 0.3, unknown: false });
  });

  it('lote sem chamada paga (nomes no cache): soma 0, custo conhecido', () => {
    expect(addCost(job(null), { costUsd: 0 })).toEqual({ costUsd: 0, unknown: false });
  });

  it('sem uso (fase pulada, ou lote sem chamada ao provedor): o custo fica como estava', () => {
    expect(addCost(job(0.5), null)).toEqual({ costUsd: 0.5, unknown: false });
    expect(addCost(job(null), undefined)).toEqual({ costUsd: null, unknown: false });
  });

  it('custo desconhecido (modelo sem preço ou chamada sem uso): nulo, nunca zero, e marcado', () => {
    expect(addCost(job(null), { costUsd: null })).toEqual({ costUsd: null, unknown: true });
    expect(addCost(job(0.5), { costUsd: null })).toEqual({ costUsd: null, unknown: true });
  });

  it('depois de desconhecido, fica nulo até o fim: a soma seguinte não volta a valer', () => {
    expect(addCost(job(null, true), { costUsd: 0.0002 })).toEqual({ costUsd: null, unknown: true });
    expect(addCost(job(null, true), null)).toEqual({ costUsd: null, unknown: true });
  });

  it('job sem cursor ainda: começa do zero', () => {
    expect(addCost({ costUsd: null, cursor: null }, { costUsd: 0.1 })).toEqual({
      costUsd: 0.1,
      unknown: false,
    });
  });

  it('withCostMark liga a marca no cursor e nunca a desliga', () => {
    const cursor = { round: 2, pass: 1, position: 3, id: 'x' };
    expect(withCostMark(cursor, true)).toEqual({ ...cursor, costUnknown: true });
    expect(withCostMark(cursor, false)).toBe(cursor);
  });
});
