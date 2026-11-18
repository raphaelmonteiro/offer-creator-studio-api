import { exampleAiRequest } from './structure-ai-request.testutil';
import {
  ABACATE_ID,
  EXAMPLE_ITEMS,
  exampleRequest,
  PICANHA_ID,
  REFRI_ID,
  TOMATE_ID,
} from './structure-suggestion.testutil';

describe('buildStructureAiRequest: o pedido ao provedor, com apelidos', () => {
  it('seções s1..s3 com os apelidos dos itens e as páginas, fixação e células do retrato', () => {
    const { sections } = exampleAiRequest();
    expect(sections).toEqual([
      {
        alias: 's1',
        category: 'Hortifruti',
        itemAliases: ['p01', 'p02', 'p03'],
        cells: 3,
        pages: [1],
      },
      { alias: 's2', category: 'Carnes', itemAliases: ['p04', 'p05', 'p06'], cells: 3, pages: [1] },
      {
        alias: 's3',
        category: 'Bebidas',
        itemAliases: ['p07', 'p08'],
        cells: 2,
        pages: [2],
        pinnedPage: 2,
      },
    ]);
  });

  it('itens p01..p08 com nome, preço e unidade do banco e "tem foto" pelo imageUrl (o TOMATE não tem)', () => {
    const { items } = exampleAiRequest();
    expect(items.map((item) => item.alias)).toEqual([
      'p01',
      'p02',
      'p03',
      'p04',
      'p05',
      'p06',
      'p07',
      'p08',
    ]);
    expect(items[3]).toEqual({
      alias: 'p04',
      sectionAlias: 's2',
      name: 'PICANHA BOVINA',
      price: { kind: 'from_to', cents: 6990, fromCents: 8990 },
      unit: 'kg',
      hasPhoto: true,
      hero: null,
    });
    expect(items.filter((item) => !item.hasPhoto).map((item) => item.name)).toEqual(['TOMATE']);
  });

  it('foto vazia ou nula é sem foto', () => {
    const items = EXAMPLE_ITEMS.map((item) =>
      item.id === ABACATE_ID ? { ...item, imageUrl: '' } : item,
    );
    expect(exampleAiRequest({ items }).items[0].hasPhoto).toBe(false);
  });

  it('o destaque que o usuário já tem vai no item, e o resto do retrato vai junto', () => {
    const request = exampleRequest({ unplaced: 3, heroes: [{ itemId: PICANHA_ID, size: '2x2' }] });
    const ai = exampleAiRequest({ request, documentName: 'Ofertas da semana 47', maxHeroes: 5 });
    expect(ai.items.find((item) => item.alias === 'p04')?.hero).toBe('2x2');
    expect(ai.items.filter((item) => item.hero !== null)).toHaveLength(1);
    expect(ai).toMatchObject({
      documentName: 'Ofertas da semana 47',
      format: '27x40',
      pageCount: 2,
      level: 2,
      unplaced: 3,
      maxHeroes: 5,
      examples: [],
    });
    expect(ai.pages).toHaveLength(2);
  });

  it('sem unplaced no pedido, 0 produto sem lugar', () => {
    expect(exampleAiRequest().unplaced).toBe(0);
  });

  it('o bloco de soltos recebe apelido e entra com os seus itens, sem categoria', () => {
    const request = exampleRequest({
      sections: [
        { id: 'cat:Carnes', itemIds: [PICANHA_ID], cells: 1, pages: [1] },
        { id: 'cat:Hortifruti', itemIds: [ABACATE_ID], cells: 1, pages: [1] },
        { id: 'loose', itemIds: [REFRI_ID], cells: 1, pages: [2], quota: 4 },
      ],
    });
    const ai = exampleAiRequest({ request });
    expect(ai.sections[2]).toEqual({
      alias: 's3',
      category: null,
      itemAliases: ['p03'],
      cells: 1,
      pages: [2],
      quota: 4,
    });
    expect(ai.items[2]).toMatchObject({
      alias: 'p03',
      sectionAlias: 's3',
      name: 'REFRIGERANTE 2L',
    });
  });

  it('id que não é item do encarte fica de fora, e o item repetido entra na primeira seção só', () => {
    const stranger = '11111111-1111-4111-8111-111111111111';
    const request = exampleRequest({
      sections: [
        { id: 'cat:Carnes', itemIds: [PICANHA_ID, stranger], cells: 1, pages: [1] },
        { id: 'cat:Hortifruti', itemIds: [PICANHA_ID, TOMATE_ID], cells: 1, pages: [1] },
      ],
    });
    const ai = exampleAiRequest({ request });
    expect(ai.sections.map((section) => section.itemAliases)).toEqual([['p01'], ['p02']]);
    expect(ai.items.map((item) => item.name)).toEqual(['PICANHA BOVINA', 'TOMATE']);
  });

  it('nada do que vai ao provedor traz um UUID', () => {
    const text = JSON.stringify(
      exampleAiRequest({
        request: exampleRequest({ heroes: [{ itemId: PICANHA_ID, size: '2x1' }] }),
      }),
    );
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
