import { randomUUID } from 'crypto';
import { exampleAiRequest } from './structure-ai-request.testutil';
import { COXA_ID, exampleRequest, LINGUICA_ID, PICANHA_ID } from './structure-suggestion.testutil';

const withSuggested = (
  ...suggestedHeroes: NonNullable<ReturnType<typeof exampleRequest>['suggestedHeroes']>
) => exampleAiRequest({ request: exampleRequest({ suggestedHeroes }) });

describe('buildStructureAiRequest: os sugeridos do motor (Sugeridos do motor no pedido da sugestão)', () => {
  it('Pedido sem o campo: nenhum produto é sugerido do motor e nenhuma página tem célula em sugeridos', () => {
    const ai = exampleAiRequest();

    expect(ai.items.map((item) => item.suggestedHero)).toEqual(Array(8).fill(null));
    expect(ai.pages.map((page) => page.suggestedCells)).toEqual([0, 0]);
  });

  it('Sugerido no pedido chega ao provedor: a COXA (p05) vai como sugerida em 2x1 e a página 1 com 1 célula', () => {
    const ai = withSuggested({ itemId: COXA_ID, size: '2x1', page: 1 });

    expect(ai.items.find((item) => item.alias === 'p05')).toMatchObject({
      hero: null,
      suggestedHero: '2x1',
    });
    expect(ai.items.filter((item) => item.suggestedHero !== null)).toHaveLength(1);
    expect(ai.pages.map((page) => [page.page, page.suggestedCells])).toEqual([
      [1, 1],
      [2, 0],
    ]);
  });

  it('o 2x2 vale 3 células a mais, e os sugeridos da mesma página somam', () => {
    const ai = withSuggested(
      { itemId: COXA_ID, size: '2x2', page: 2 },
      { itemId: LINGUICA_ID, size: '2x1', page: 2 },
      { itemId: PICANHA_ID, size: '2x1', page: 1 },
    );

    expect(ai.pages.map((page) => page.suggestedCells)).toEqual([1, 4]);
    expect(ai.items.map((item) => item.suggestedHero).filter(Boolean)).toEqual([
      '2x1',
      '2x2',
      '2x1',
    ]);
  });

  it('Sugerido que não é item do encarte: o UUID de outro encarte é ignorado e não conta célula', () => {
    const ai = withSuggested({ itemId: randomUUID(), size: '2x2', page: 1 });

    expect(ai.items).toHaveLength(8);
    expect(ai.items.every((item) => item.suggestedHero === null)).toBe(true);
    expect(ai.pages.map((page) => page.suggestedCells)).toEqual([0, 0]);
  });

  it('o destaque do usuário segue em hero, sem virar sugerido', () => {
    const request = exampleRequest({
      heroes: [{ itemId: PICANHA_ID, size: '2x2' }],
      suggestedHeroes: [{ itemId: COXA_ID, size: '2x1', page: 1 }],
    });
    const ai = exampleAiRequest({ request });

    expect(ai.items.find((item) => item.alias === 'p04')).toMatchObject({
      hero: '2x2',
      suggestedHero: null,
    });
    expect(ai.items.find((item) => item.alias === 'p05')).toMatchObject({
      hero: null,
      suggestedHero: '2x1',
    });
  });

  it('nada do que vai ao provedor traz um UUID, com sugeridos também', () => {
    const text = JSON.stringify(withSuggested({ itemId: COXA_ID, size: '2x1', page: 1 }));

    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
