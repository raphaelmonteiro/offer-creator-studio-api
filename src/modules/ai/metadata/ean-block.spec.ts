import { mergeEanBlock } from './ean-block';
import { ProductMetadata } from './product-metadata.schema';

const BASE: ProductMetadata = {
  title: 'Leite Condensado Moça Lata 395g',
  category: null,
  quantity: { value: 395, unit: 'g' },
  packageType: 'lata',
  pack: null,
  alternatives: [{ brand: 'Moça', subBrand: null, variant: null }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: {},
  source: 'vision',
  modelVersion: 'vision-v1',
  warnings: [],
};

const DOTCOMPANY: ProductMetadata = {
  ...BASE,
  source: 'name-parse',
  ean: '7891000100103',
  eanSource: 'dotcompany',
  eanVerifiedBy: 'exact',
  eanConfidence: 1,
  eanVerifiedAt: '2026-10-10T12:00:00.000Z',
  eanStatus: 'resolved',
};

/** O que uma nova extração por visão devolve: descritivo novo, sem bloco EAN. */
const VISAO: ProductMetadata = {
  ...BASE,
  title: 'Leite Condensado Moça 395g',
  modelVersion: 'vision-v2',
};

describe('mergeEanBlock', () => {
  it('sem EAN atual, grava o que chegou', () => {
    expect(mergeEanBlock(BASE, VISAO)).toEqual(VISAO);
    expect(mergeEanBlock(null, VISAO)).toEqual(VISAO);
  });

  it('nova extração por visão atualiza o descritivo e preserva o EAN dotcompany inteiro', () => {
    const r = mergeEanBlock(DOTCOMPANY, VISAO);
    expect(r.title).toBe('Leite Condensado Moça 395g');
    expect(r.modelVersion).toBe('vision-v2');
    expect(r).toMatchObject({
      ean: '7891000100103',
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanConfidence: 1,
      eanVerifiedAt: '2026-10-10T12:00:00.000Z',
      eanStatus: 'resolved',
    });
  });

  it('visão que lê outro EAN não substitui: mantém o atual e registra a divergência', () => {
    const r = mergeEanBlock(DOTCOMPANY, { ...VISAO, ean: '7891000100110' });
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
    expect(r.warnings).toContain('ean-divergente:7891000100110');
  });

  it('visão que lê o mesmo EAN não gera aviso', () => {
    const r = mergeEanBlock(DOTCOMPANY, { ...VISAO, ean: '7891000100103' });
    expect(r.warnings).toEqual([]);
    expect(r.eanSource).toBe('dotcompany');
  });

  it('fonte menor (off) não sobrescreve dotcompany', () => {
    const r = mergeEanBlock(DOTCOMPANY, {
      ...DOTCOMPANY,
      ean: '7891000999998',
      eanSource: 'off',
      eanVerifiedBy: null,
      eanConfidence: 0.8,
    });
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
    expect(r.eanConfidence).toBe(1);
    expect(r.warnings).toContain('ean-divergente:7891000999998');
  });

  it('revisão manual prevalece sobre dotcompany', () => {
    const manual = {
      ...DOTCOMPANY,
      ean: '7891000100110',
      eanSource: 'manual' as const,
      eanVerifiedBy: 'human' as const,
    };
    expect(mergeEanBlock(DOTCOMPANY, manual)).toEqual(manual);
  });

  it('dotcompany substitui EAN de fonte menor', () => {
    const off = { ...BASE, ean: '7891000999998', eanSource: 'off' as const, eanConfidence: 0.7 };
    expect(mergeEanBlock(off, DOTCOMPANY)).toEqual(DOTCOMPANY);
  });

  it('metadata legado com EAN sem fonte aceita nova leitura sem fonte', () => {
    const legado = { ...BASE, ean: '7891000999998' };
    const nova = { ...VISAO, ean: '7891000100103' };
    expect(mergeEanBlock(legado, nova)).toEqual(nova);
  });

  it('limpeza só apaga EAN da fonte indicada', () => {
    const off = {
      ...BASE,
      ean: '7891000999998',
      eanSource: 'off' as const,
      eanStatus: 'resolved' as const,
    };
    const limpo = { ...off, ean: null, eanSource: null, eanStatus: 'review' as const };
    expect(mergeEanBlock(off, limpo, { clearEanSource: 'off' })).toEqual(limpo);

    const r = mergeEanBlock(
      DOTCOMPANY,
      { ...DOTCOMPANY, ean: null, eanSource: null },
      { clearEanSource: 'off' },
    );
    expect(r.ean).toBe('7891000100103');
    expect(r.eanSource).toBe('dotcompany');
  });
});
