import { DEFAULT_PRODUCT_CATEGORIES } from '../../ai/product-categorization.service';
import { FLYER_PRO_CATEGORIES } from './flyer-pro-categories';

describe('FLYER_PRO_CATEGORIES', () => {
  it('são as de DEFAULT_PRODUCT_CATEGORIES sem "Sem categoria", como conjuntos', () => {
    const fromService = DEFAULT_PRODUCT_CATEGORIES.filter((name) => name !== 'Sem categoria');

    expect(new Set(FLYER_PRO_CATEGORIES)).toEqual(new Set(fromService));
    expect(FLYER_PRO_CATEGORIES).toHaveLength(11);
  });

  it('a chave é "Frios e Laticinios", sem acento, e "Sem categoria" não é valor', () => {
    expect(FLYER_PRO_CATEGORIES).toContain('Frios e Laticinios');
    expect(FLYER_PRO_CATEGORIES).not.toContain('Frios e Laticínios');
    expect(FLYER_PRO_CATEGORIES).not.toContain('Sem categoria');
  });
});
