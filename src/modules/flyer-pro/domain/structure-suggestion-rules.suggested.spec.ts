import { validateStructureState } from './structure-suggestion-rules';
import { COXA_ID, exampleRequest, LINGUICA_ID } from './structure-suggestion.testutil';
import type { StructureSuggestedHeroInput } from './structure-suggestion.types';

const stateWith = (suggestedHeroes: StructureSuggestedHeroInput[] | undefined, pageCount = 2) =>
  validateStructureState(exampleRequest({ suggestedHeroes, pageCount }));

const suggested = (itemId: string, page = 1): StructureSuggestedHeroInput => ({
  itemId,
  size: '2x1',
  page,
});

describe('validateStructureState: suggestedHeroes (Sugeridos do motor no pedido da sugestão)', () => {
  it('sem o campo, com a lista vazia e com sugeridos distintos nas páginas do retrato, o retrato é coerente', () => {
    expect(stateWith(undefined)).toEqual([]);
    expect(stateWith([])).toEqual([]);
    expect(stateWith([suggested(COXA_ID, 1), suggested(LINGUICA_ID, 2)])).toEqual([]);
  });

  it('Sugerido repetido: o mesmo itemId duas vezes é ITEM_DUPLICATED em suggestedHeroes', () => {
    expect(stateWith([suggested(COXA_ID), suggested(COXA_ID, 2)])).toEqual([
      { field: 'suggestedHeroes', code: 'ITEM_DUPLICATED' },
    ]);
  });

  it('Sugerido em página que não existe: page acima de pageCount é PAGES_MISMATCH em suggestedHeroes, uma vez só', () => {
    expect(stateWith([suggested(COXA_ID, 3)])).toEqual([
      { field: 'suggestedHeroes', code: 'PAGES_MISMATCH' },
    ]);
    expect(stateWith([suggested(COXA_ID, 3), suggested(LINGUICA_ID, 4)])).toEqual([
      { field: 'suggestedHeroes', code: 'PAGES_MISMATCH' },
    ]);
    expect(stateWith([suggested(COXA_ID, 2)], 2)).toEqual([]);
  });

  it('os dois problemas juntos saem na ordem dos códigos: as páginas antes, o item repetido depois', () => {
    expect(stateWith([suggested(COXA_ID, 3), suggested(COXA_ID, 3)])).toEqual([
      { field: 'suggestedHeroes', code: 'PAGES_MISMATCH' },
      { field: 'suggestedHeroes', code: 'ITEM_DUPLICATED' },
    ]);
  });

  it('um id que não é item do encarte não é problema de coerência (o serviço o ignora)', () => {
    expect(stateWith([suggested('7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0cff')])).toEqual([]);
  });
});
