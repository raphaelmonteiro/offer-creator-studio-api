import { FLYER_PRO_CATEGORIES } from './flyer-pro-categories';
import {
  CATEGORY_CONFIDENCE_THRESHOLD,
  canonicalCategory,
  CategoryAnswer,
  categorizationRequest,
  categoryDescription,
  categoryVerdictOf,
  keepsCurrentCategory,
} from './flyer-pro-enrich-category';

const answer = (category: string, confidence: number, extra: Partial<CategoryAnswer> = {}) =>
  ({
    productId: 'i1',
    category,
    confidence,
    source: 'ai',
    reason: 'motivo',
    ...extra,
  }) as CategoryAnswer;

const missing = { id: 'i1', category: null, categorySource: null };
const sheet = (category: string) => ({ id: 'i1', category, categorySource: 'import' });
const aiApplied = (category: string) => ({ id: 'i1', category, categorySource: 'ai' });

describe('limiar e comparação de categoria', () => {
  it('o limiar é 0,65', () => {
    expect(CATEGORY_CONFIDENCE_THRESHOLD).toBe(0.65);
  });

  it.each([
    ['Frios e Laticínios', 'Frios e Laticinios'],
    ['FRIOS E LATICINIOS', 'Frios e Laticinios'],
    ['higiene e perfumaria', 'Higiene e Perfumaria'],
    ['Pet', 'Pet'],
  ])('canonicalCategory(%s) é %s (sem acento e sem maiúsculas)', (given, expected) => {
    expect(canonicalCategory(given)).toBe(expected);
  });

  it.each(['Açougue', 'Sem categoria', '', 'Produtos soltos'])(
    'canonicalCategory(%s) é nulo: fora das 11',
    (given) => {
      expect(canonicalCategory(given)).toBeNull();
    },
  );

  it('as 11 categorias são reconhecidas', () => {
    for (const category of FLYER_PRO_CATEGORIES) expect(canonicalCategory(category)).toBe(category);
  });
});

describe('pedido da categorização (A-20)', () => {
  it('item com a categoria da planilha vai com a descrição e currentCategory nulo', () => {
    const request = categorizationRequest([
      { id: 'a', name: 'SABÃO EM PÓ 1KG', unit: 'cada', imported: { rawCategory: 'MERCEARIA' } },
    ] as never);
    expect(request.products[0]).toEqual({
      id: 'a',
      name: 'SABÃO EM PÓ 1KG',
      unit: 'cada',
      currentCategory: null,
      description: 'Categoria na planilha: MERCEARIA',
    });
  });

  it.each([
    ['sem imported', null],
    ['rawCategory em branco', { rawCategory: '   ' }],
    ['sem a chave rawCategory', {}],
  ])('item %s vai sem descrição', (_, imported) => {
    const [product] = categorizationRequest([
      { id: 'a', name: 'ABACATE', unit: 'kg', imported },
    ] as never).products;
    expect(product).not.toHaveProperty('description');
    expect(product.currentCategory).toBeNull();
    expect(categoryDescription({ imported } as never)).toBeUndefined();
  });

  it('a lista traz exatamente as 11 categorias e preserveExistingCategories ligado', () => {
    const request = categorizationRequest([]);
    expect(request.allowedCategories).toEqual([...FLYER_PRO_CATEGORIES]);
    expect(request.allowedCategories).toHaveLength(11);
    expect(request.preserveExistingCategories).toBe(true);
  });
});

describe('resposta da categorização → veredito da porta', () => {
  it('fallback não grava', () => {
    expect(categoryVerdictOf(missing, answer('Sem categoria', 0, { source: 'fallback' }))).toEqual({
      itemId: 'i1',
      action: 'unanswered',
    });
  });

  it('item sem resposta não grava', () => {
    expect(categoryVerdictOf(missing, undefined).action).toBe('unanswered');
  });

  it('categoria fora das 11 vale como fallback', () => {
    expect(categoryVerdictOf(missing, answer('Açougue', 0.9)).action).toBe('unanswered');
  });

  it.each([missing, sheet('Mercearia'), aiApplied('Bebidas')])(
    '"Sem categoria" é none para qualquer origem',
    (item) => {
      expect(categoryVerdictOf(item, answer('Sem categoria', 0.9)).action).toBe('none');
    },
  );

  it('sem categoria, a partir de 0,65: apply', () => {
    expect(categoryVerdictOf(missing, answer('Bebidas', 0.65))).toEqual({
      itemId: 'i1',
      action: 'apply',
      category: 'Bebidas',
      confidence: 0.65,
      why: 'motivo',
    });
  });

  it('sem categoria, abaixo de 0,65: suggest', () => {
    expect(categoryVerdictOf(missing, answer('Mercearia', 0.55)).action).toBe('suggest');
  });

  it('a categoria volta na grafia da lista (com acento da tela vira a chave)', () => {
    const verdict = categoryVerdictOf(missing, answer('Frios e Laticínios', 0.9));
    expect(verdict).toMatchObject({ action: 'apply', category: 'Frios e Laticinios' });
  });

  it('o motivo ausente vira nulo', () => {
    const verdict = categoryVerdictOf(missing, answer('Pet', 0.9, { reason: undefined }));
    expect(verdict).toMatchObject({ why: null });
  });

  it('planilha: outra categoria com certeza vira suggest (troca sugerida)', () => {
    expect(categoryVerdictOf(sheet('Mercearia'), answer('Limpeza', 0.88)).action).toBe('suggest');
  });

  it('planilha: outra categoria no limiar (0,65) vira suggest', () => {
    expect(categoryVerdictOf(sheet('Mercearia'), answer('Limpeza', 0.65)).action).toBe('suggest');
  });

  it('planilha: a IA concorda, é none', () => {
    expect(categoryVerdictOf(sheet('Hortifruti'), answer('Hortifruti', 0.97)).action).toBe('none');
  });

  it('planilha: mesma categoria com outra grafia (acento) é none', () => {
    expect(
      categoryVerdictOf(sheet('Frios e Laticinios'), answer('Frios e Laticínios', 0.9)).action,
    ).toBe('none');
  });

  it('planilha: discorda com pouca confiança é none', () => {
    expect(categoryVerdictOf(sheet('Hortifruti'), answer('Mercearia', 0.55)).action).toBe('none');
  });

  it('refazer (ai): certeza é apply, mesmo sendo a mesma categoria', () => {
    expect(categoryVerdictOf(aiApplied('Bebidas'), answer('Bebidas', 0.95)).action).toBe('apply');
    expect(categoryVerdictOf(aiApplied('Bebidas'), answer('Mercearia', 0.8)).action).toBe('apply');
  });

  it('refazer (ai): incerto é suggest', () => {
    expect(categoryVerdictOf(aiApplied('Bebidas'), answer('Mercearia', 0.5)).action).toBe(
      'suggest',
    );
  });

  it('confiança que não é número vale 0 (suggest, nunca apply)', () => {
    expect(categoryVerdictOf(missing, answer('Pet', Number.NaN)).action).toBe('suggest');
  });
});

describe('keepsCurrentCategory: a categoria respondida é a que o item já tem', () => {
  const choice = (action: 'apply' | 'suggest', category = 'Bebidas') => ({ action, category });

  it('item sem categoria nunca "mantém"', () => {
    expect(keepsCurrentCategory(missing, choice('apply'), true)).toBe(false);
  });

  it('planilha com a mesma categoria mantém, com autoApply ligado ou não', () => {
    expect(keepsCurrentCategory(sheet('Bebidas'), choice('apply'), true)).toBe(true);
    expect(keepsCurrentCategory(sheet('Bebidas'), choice('suggest'), false)).toBe(true);
  });

  it('planilha com outra categoria não mantém', () => {
    expect(keepsCurrentCategory(sheet('Mercearia'), choice('suggest'), true)).toBe(false);
  });

  it('ai com a mesma categoria, certeza e autoApply regrava (confirma)', () => {
    expect(keepsCurrentCategory(aiApplied('Bebidas'), choice('apply'), true)).toBe(false);
  });

  it('ai com a mesma categoria, sem autoApply ou incerta, mantém', () => {
    expect(keepsCurrentCategory(aiApplied('Bebidas'), choice('apply'), false)).toBe(true);
    expect(keepsCurrentCategory(aiApplied('Bebidas'), choice('suggest'), true)).toBe(true);
  });
});
