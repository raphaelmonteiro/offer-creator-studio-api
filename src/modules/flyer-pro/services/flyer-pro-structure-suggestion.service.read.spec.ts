import { In } from 'typeorm';
import type { StructureExampleRow } from '../domain/read-structure-example';
import type { StructureAiResult } from '../domain/structure-ai-request';
import { exampleRequest } from '../domain/structure-suggestion.testutil';
import {
  bodyOf,
  CLIENT_ID,
  DOCUMENT_ID,
  documentRow,
  fakePort,
  makeSuggestionService,
} from './flyer-pro-structure-suggestion.service.testutil';

const EMPTY: StructureAiResult = {
  suggestion: { summary: '', sections: [], heroes: [] },
  model: 'gpt-6-luna',
  usage: null,
};

const pages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    page: index + 1,
    capacityCells: 8,
    usedCells: 1,
    header: false,
    footer: false,
  }));

const sectionList = (...ids: string[]) => ids.map((id) => ({ id }));

/** Um encarte anterior do cliente com a ordem Carnes, Hortifruti (deliberada) e as seções dadas. */
const deliberateRow = (over: Partial<StructureExampleRow> = {}): StructureExampleRow => ({
  format: '27x40',
  pageCount: 2,
  schemaVersion: 1,
  structure: { sections: sectionList('cat:Carnes', 'cat:Hortifruti') },
  ...over,
});

describe('FlyerProStructureSuggestionService: páginas pelo formato', () => {
  it('54x40 com 3 páginas é 422 FLYER_PRO_PAGE_COUNT_INVALID com format e allowed, sem chamar o provedor', async () => {
    const { port, suggest } = fakePort(EMPTY);
    const { service } = makeSuggestionService({ port, document: documentRow({ format: '54x40' }) });

    await expect(
      service.suggest(DOCUMENT_ID, bodyOf({ pageCount: 3, pages: pages(3) })),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'FLYER_PRO_PAGE_COUNT_INVALID',
        details: { format: '54x40', allowed: [2, 4] },
      },
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it('54x40 aceita 2 e 4 páginas, e o 27x40 aceita 1 a 4', async () => {
    const unpinned = exampleRequest().sections.map(
      ({ pinnedPage: _pinned, ...section }) => section,
    );
    const bodyWith = (count: number) =>
      bodyOf({ pageCount: count, pages: pages(count), sections: unpinned });
    const wide = makeSuggestionService({ document: documentRow({ format: '54x40' }) });
    for (const count of [2, 4]) {
      await expect(wide.service.suggest(DOCUMENT_ID, bodyWith(count))).resolves.toBeDefined();
    }
    const narrow = makeSuggestionService();
    for (const count of [1, 2, 3, 4]) {
      await expect(narrow.service.suggest(DOCUMENT_ID, bodyWith(count))).resolves.toBeDefined();
    }
  });

  it('o pageCount do pedido vale mesmo que seja diferente do gravado (a tela está à frente do banco)', async () => {
    const { port, suggest } = fakePort(EMPTY);
    const { service } = makeSuggestionService({ port });

    await service.suggest(DOCUMENT_ID, bodyOf({ pageCount: 2, pages: pages(2) }));

    expect(suggest.mock.calls[0][0].pageCount).toBe(2);
  });
});

describe('FlyerProStructureSuggestionService: itens do pedido lidos do encarte', () => {
  it('consulta só os ids distintos do pedido, dentro do encarte, com as colunas que o provedor lê', async () => {
    const { service, mocks } = makeSuggestionService();
    const request = exampleRequest();
    request.sections[1].itemIds = [...request.sections[1].itemIds];

    await service.suggest(DOCUMENT_ID, bodyOf());

    const [entity, options] = mocks.find.mock.calls[0];
    expect(entity.name).toBe('FlyerProItem');
    expect(options.where.documentId).toBe(DOCUMENT_ID);
    expect(options.where.id).toEqual(In(request.sections.flatMap((section) => section.itemIds)));
    expect(options.select).toEqual({
      id: true,
      name: true,
      price: true,
      unit: true,
      category: true,
      imageUrl: true,
    });
  });

  it('id estranho no meio dos itens é ignorado: basedOn.items conta só os que o banco devolveu', async () => {
    const { EXAMPLE_ITEMS } = await import('../domain/structure-suggestion.testutil');
    const { service } = makeSuggestionService({ items: EXAMPLE_ITEMS.slice(0, 6) });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.basedOn.items).toBe(6);
  });

  it('nenhum id do pedido é item do encarte: 422 FLYER_PRO_NO_ITEMS com details, sem chamar o provedor', async () => {
    const { port, suggest } = fakePort(EMPTY);
    const { service } = makeSuggestionService({ port, items: [] });

    await expect(service.suggest(DOCUMENT_ID, bodyOf())).rejects.toMatchObject({
      status: 422,
      response: { code: 'FLYER_PRO_NO_ITEMS', details: {} },
    });
    expect(suggest).not.toHaveBeenCalled();
  });

  it('pedido sem nenhum id de item também é 422 FLYER_PRO_NO_ITEMS, sem consultar itens', async () => {
    const { service, mocks } = makeSuggestionService();
    const empty = bodyOf({
      sections: exampleRequest().sections.map((section) => ({ ...section, itemIds: [] })),
    });

    await expect(service.suggest(DOCUMENT_ID, empty)).rejects.toMatchObject({
      response: { code: 'FLYER_PRO_NO_ITEMS' },
    });
    expect(mocks.find).not.toHaveBeenCalled();
  });
});

describe('FlyerProStructureSuggestionService: exemplos dos encartes anteriores do cliente', () => {
  it('lê até 10 encartes do mesmo cliente, de outro id, e usa só os deliberados', async () => {
    const { service, mocks } = makeSuggestionService({
      exampleRows: [
        deliberateRow(),
        deliberateRow({ structure: { sections: sectionList('cat:Hortifruti', 'cat:Carnes') } }),
        deliberateRow({ structure: { sections: 'Carnes,Hortifruti' } }),
      ],
    });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.basedOn.clientFlyers).toBe(1);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain(
      '"clientId" = $1 AND "id" <> $2 AND "deletedAt" IS NULL AND "pagesFrozen" = true',
    );
    expect(sql).toContain('ORDER BY "updatedAt" DESC');
    expect(params).toEqual([CLIENT_ID, DOCUMENT_ID, 10]);
  });

  it('o exemplo entra no pedido ao provedor, com o formato, as páginas e a ordem do cliente', async () => {
    const { port, suggest } = fakePort(EMPTY);
    const { service } = makeSuggestionService({ port, exampleRows: [deliberateRow()] });

    await service.suggest(DOCUMENT_ID, bodyOf());

    expect(suggest.mock.calls[0][0].examples).toEqual([
      {
        format: '27x40',
        pageCount: 2,
        sections: [
          { category: 'Carnes', page: null },
          { category: 'Hortifruti', page: null },
        ],
        deliberate: true,
      },
    ]);
  });

  it('com quatro deliberados, os três primeiros (os mais recentes) entram', async () => {
    const { service } = makeSuggestionService({
      exampleRows: Array.from({ length: 4 }, () => deliberateRow()),
    });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.basedOn.clientFlyers).toBe(3);
  });

  it('EXAMPLES=0 não consulta nenhum encarte anterior', async () => {
    const { service, mocks } = makeSuggestionService({
      config: { examples: 0 },
      exampleRows: [deliberateRow()],
    });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.basedOn.clientFlyers).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('EXAMPLES=1 usa um só', async () => {
    const { service } = makeSuggestionService({
      config: { examples: 1 },
      exampleRows: [deliberateRow(), deliberateRow()],
    });

    expect((await service.suggest(DOCUMENT_ID, bodyOf())).basedOn.clientFlyers).toBe(1);
  });

  it('encarte anterior pulado (schemaVersion 2, fatia vazia) não conta nem derruba a resposta', async () => {
    const { service } = makeSuggestionService({
      exampleRows: [deliberateRow({ schemaVersion: 2 }), deliberateRow({ structure: {} })],
    });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.basedOn.clientFlyers).toBe(0);
  });
});
