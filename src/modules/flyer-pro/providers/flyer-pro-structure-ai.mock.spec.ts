import { exampleAiRequest } from '../domain/structure-ai-request.testutil';
import { sanitizeSuggestion } from '../domain/structure-suggestion-sanitize';
import {
  discardedCodes,
  sanitizeContext,
  sectionIds,
} from '../domain/structure-suggestion-sanitize.testutil';
import {
  ABACATE_ID,
  EXAMPLE_ITEMS,
  exampleRequest,
  PICANHA_ID,
} from '../domain/structure-suggestion.testutil';
import type { StructureRequest } from '../domain/structure-suggestion.types';
import { StructureAiFailure } from './flyer-pro-structure-ai.port';
import { MOCK_SLOW_MS, MockFlyerProStructureAi } from './flyer-pro-structure-ai.mock';

const OPTIONS = { timeoutMs: 25_000 };

function makeMock() {
  const sleep = jest.fn().mockResolvedValue(undefined);
  return { mock: new MockFlyerProStructureAi(sleep), sleep };
}

/** A resposta do simulado para o retrato, já saneada como a rota a entrega. */
async function suggestionFor(name: string, request: StructureRequest = exampleRequest()) {
  const { mock } = makeMock();
  const { suggestion } = await mock.suggest(
    exampleAiRequest({ documentName: name, request }),
    OPTIONS,
  );
  return sanitizeSuggestion(suggestion, sanitizeContext(request));
}

describe('MockFlyerProStructureAi: tabela fixa', () => {
  it('é o provedor simulado, sem chave nem preço, sem tokens', async () => {
    const { mock } = makeMock();
    expect(mock.source).toBe('mock');
    expect(mock.unavailableReason()).toBeNull();
    const result = await mock.suggest(exampleAiRequest(), OPTIONS);
    expect(result.model).toBe('mock');
    expect(result.usage).toBeNull();
  });

  it('o exemplo: Carnes, Hortifruti, Bebidas; Carnes na página 1; Bebidas na 2; dois destaques 2x1', async () => {
    const result = await suggestionFor('Ofertas da semana 47');
    expect(result.sections).toEqual([
      { id: 'cat:Carnes', page: 1, reason: expect.stringMatching(/^\[simulado\] .+/) },
      { id: 'cat:Hortifruti', page: null, reason: expect.stringMatching(/^\[simulado\] .+/) },
      { id: 'cat:Bebidas', page: 2, reason: expect.stringMatching(/^\[simulado\] .+/) },
    ]);
    expect(result.heroes.map((hero) => [hero.itemId, hero.size])).toEqual([
      [PICANHA_ID, '2x1'],
      [ABACATE_ID, '2x1'],
    ]);
    expect(result.heroes.every((hero) => hero.reason.startsWith('[simulado] '))).toBe(true);
    expect(result.summary).toMatch(/^\[simulado\] .+/);
    expect(result.noChange).toBe(false);
    expect(result.discarded).toEqual([]);
  });

  it('com as seções em ordem qualquer, devolve a ordem fixa das 11 categorias, só as do pedido', async () => {
    const names = [
      'Bazar',
      'Pet',
      'Limpeza',
      'Congelados',
      'Padaria',
      'Frios e Laticinios',
      'Mercearia',
      'Bebidas',
      'Hortifruti',
      'Carnes',
    ];
    const request = exampleRequest({
      sections: names.map((name) => ({ id: `cat:${name}`, itemIds: [], cells: 1, pages: [1] })),
    });
    const { mock } = makeMock();
    const { suggestion } = await mock.suggest(exampleAiRequest({ request }), OPTIONS);
    const sanitized = sanitizeSuggestion(suggestion, sanitizeContext(request));
    expect(sectionIds(sanitized)).toEqual([...names].reverse().map((name) => `cat:${name}`));
    expect(suggestion.sections.map((entry) => entry.page)).toEqual([1, ...Array(9).fill(null)]);
  });

  it('o bloco de soltos nunca volta', async () => {
    const request = exampleRequest({
      sections: [
        { id: 'cat:Hortifruti', itemIds: [ABACATE_ID], cells: 1, pages: [1] },
        { id: 'cat:Carnes', itemIds: [PICANHA_ID], cells: 1, pages: [1] },
        { id: 'loose', itemIds: [], cells: 1, pages: [2] },
      ],
    });
    const result = await suggestionFor('Ofertas', request);
    expect(sectionIds(result)).toEqual(['cat:Carnes', 'cat:Hortifruti']);
  });

  it('primeira seção sem item com foto: o destaque vem só do ABACATE, de Hortifruti', async () => {
    const items = EXAMPLE_ITEMS.map((item) =>
      item.category === 'Carnes' ? { ...item, imageUrl: null } : item,
    );
    const { mock } = makeMock();
    const ai = exampleAiRequest({ items });
    const { suggestion } = await mock.suggest(ai, OPTIONS);
    const result = sanitizeSuggestion(suggestion, {
      ...sanitizeContext(),
      itemsWithPhoto: new Set(items.filter((item) => item.imageUrl).map((item) => item.id)),
    });
    expect(result.heroes.map((hero) => hero.itemId)).toEqual([ABACATE_ID]);
    expect(suggestion.heroes).toHaveLength(1);
  });

  it('a terceira seção nunca ganha destaque, mesmo com a primeira sem foto', async () => {
    const items = EXAMPLE_ITEMS.map((item) =>
      item.category === 'Carnes' ? { ...item, imageUrl: null } : item,
    );
    const { mock } = makeMock();
    const { suggestion } = await mock.suggest(exampleAiRequest({ items }), OPTIONS);
    expect(suggestion.heroes.map((hero) => hero.item)).toEqual(['p01']);
  });

  it('o mesmo pedido duas vezes dá a mesma resposta', async () => {
    const { mock } = makeMock();
    const ai = exampleAiRequest();
    const first = await mock.suggest(ai, OPTIONS);
    const second = await mock.suggest(ai, OPTIONS);
    expect(second).toEqual(first);
  });

  it('Carnes fixada na página 2: vem primeiro, com page 2, e USER_PINNED', async () => {
    const request = exampleRequest();
    request.sections[1].pinnedPage = 2;
    const result = await suggestionFor('Ofertas', request);
    expect(result.sections[0]).toMatchObject({ id: 'cat:Carnes', page: 2 });
    expect(result.discarded).toEqual([{ kind: 'page', code: 'USER_PINNED' }]);
  });
});

describe('MockFlyerProStructureAi: marcadores no nome do encarte', () => {
  it('#ia-falha lança StructureAiFailure PROVIDER_ERROR, também em maiúsculas', async () => {
    for (const name of ['Teste #ia-falha', 'TESTE #IA-FALHA']) {
      const { mock } = makeMock();
      await expect(mock.suggest(exampleAiRequest({ documentName: name }), OPTIONS)).rejects.toEqual(
        expect.objectContaining({ reason: 'PROVIDER_ERROR' }),
      );
      await expect(
        mock.suggest(exampleAiRequest({ documentName: name }), OPTIONS),
      ).rejects.toBeInstanceOf(StructureAiFailure);
    }
  });

  it('#ia-lenta espera 3 s antes de responder normalmente', async () => {
    const { mock, sleep } = makeMock();
    const result = await mock.suggest(
      exampleAiRequest({ documentName: 'Teste #IA-LENTA' }),
      OPTIONS,
    );
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(MOCK_SLOW_MS);
    expect(MOCK_SLOW_MS).toBe(3000);
    expect(result.suggestion.sections).toHaveLength(3);
  });

  it('sem #ia-lenta, nenhuma espera', async () => {
    const { mock, sleep } = makeMock();
    await mock.suggest(exampleAiRequest(), OPTIONS);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('#ia-igual devolve a ordem atual, sem página e sem destaque (Bebidas ganha a fixada no saneamento)', async () => {
    const result = await suggestionFor('Teste #ia-igual');
    expect(sectionIds(result)).toEqual(['cat:Hortifruti', 'cat:Carnes', 'cat:Bebidas']);
    expect(result.sections.map((entry) => entry.page)).toEqual([null, null, 2]);
    expect(result.heroes).toEqual([]);
    expect(result.noChange).toBe(true);
    expect(result.sections.every((entry) => entry.reason.startsWith('[simulado] '))).toBe(true);
  });

  it('#ia-lenta e #ia-igual juntos: espera 3 s e devolve a ordem atual', async () => {
    const { mock, sleep } = makeMock();
    const { suggestion } = await mock.suggest(
      exampleAiRequest({ documentName: 'Teste #IA-LENTA #ia-igual' }),
      OPTIONS,
    );
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(suggestion.heroes).toEqual([]);
    expect(suggestion.sections.map((entry) => entry.id)).toEqual(['s1', 's2', 's3']);
  });

  it('#ia-falha vence #ia-igual e #ia-nao-cabe; #ia-lenta ainda espera antes da falha', async () => {
    const { mock, sleep } = makeMock();
    for (const name of [
      'Teste #ia-igual #ia-falha',
      'Teste #ia-nao-cabe #ia-falha',
      '#ia-lenta #ia-falha',
    ]) {
      await expect(
        mock.suggest(exampleAiRequest({ documentName: name }), OPTIONS),
      ).rejects.toMatchObject({
        reason: 'PROVIDER_ERROR',
      });
    }
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('MockFlyerProStructureAi: #ia-nao-cabe', () => {
  /** Bebidas ocupa 7 células e a página 2 está com 7 de 8 (o exemplo da spec). */
  const crowded = () => {
    const request = exampleRequest();
    request.sections[2].cells = 7;
    request.pages[1].usedCells = 7;
    return request;
  };

  it('Hortifruti (empata com Carnes em 3 células e vem antes) vai para a página 2, a mais cheia sem ela', async () => {
    const result = await suggestionFor('Teste #ia-nao-cabe', crowded());
    expect(result.sections).toEqual([
      expect.objectContaining({ id: 'cat:Carnes', page: 1 }),
      expect.objectContaining({ id: 'cat:Hortifruti', page: 2 }),
      expect.objectContaining({ id: 'cat:Bebidas', page: 2 }),
    ]);
    expect(result.discarded).toEqual([]);
  });

  it('a maior seção sem fixação: a de mais células, mesmo que não seja a primeira', async () => {
    const request = crowded();
    request.sections[1].cells = 5;
    const result = await suggestionFor('#ia-nao-cabe', request);
    expect(result.sections.find((entry) => entry.id === 'cat:Carnes')).toMatchObject({ page: 2 });
    expect(result.sections.find((entry) => entry.id === 'cat:Hortifruti')?.page).toBeNull();
  });

  it('empate de enchimento: a página de menor número entre as que a seção não ocupa', async () => {
    const request = exampleRequest({
      pageCount: 3,
      pages: [1, 2, 3].map((page) => ({
        page,
        capacityCells: 8,
        usedCells: 4,
        header: false,
        footer: false,
      })),
    });
    request.sections[0].pages = [1];
    request.sections[1].cells = 1;
    request.sections[0].cells = 5;
    const { mock } = makeMock();
    const ai = exampleAiRequest({ request, documentName: '#ia-nao-cabe' });
    const { suggestion } = await mock.suggest(ai, OPTIONS);
    expect(suggestion.sections.find((entry) => entry.id === 's1')?.page).toBe(2);
  });

  it('sem página em que a seção não esteja, ou sem seção livre, devolve a resposta normal', async () => {
    const everywhere = crowded();
    everywhere.sections.forEach((section) => (section.pages = [1, 2]));
    const normal = await suggestionFor('Ofertas', everywhere);
    const result = await suggestionFor('#ia-nao-cabe', everywhere);
    expect(result).toEqual(normal);
    const pinned = crowded();
    pinned.sections.forEach((section) => (section.pinnedPage = 1));
    expect(await suggestionFor('#ia-nao-cabe', pinned)).toEqual(
      await suggestionFor('Ofertas', pinned),
    );
  });

  it('#ia-igual vence #ia-nao-cabe: noChange e nenhuma página além da fixada de Bebidas', async () => {
    const result = await suggestionFor('Teste #ia-nao-cabe #ia-igual', crowded());
    expect(result.noChange).toBe(true);
    expect(result.sections.map((entry) => entry.page)).toEqual([null, null, 2]);
    expect(discardedCodes(result)).toEqual([]);
  });
});
