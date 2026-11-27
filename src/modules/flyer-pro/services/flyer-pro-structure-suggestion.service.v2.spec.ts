import { randomUUID } from 'crypto';
import { rawSection, rawUnsuggest } from '../domain/structure-suggestion-sanitize.testutil';
import {
  COXA_ID,
  EMPTY_RAW_SUGGESTION,
  exampleRequest,
  LINGUICA_ID,
  PICANHA_ID,
} from '../domain/structure-suggestion.testutil';
import type { StructureAiResult } from '../domain/structure-ai-request';
import type { RawStructureSuggestion } from '../domain/structure-suggestion.types';
import {
  bodyOf,
  DOCUMENT_ID,
  documentRow,
  fakePort,
  makeSuggestionService,
} from './flyer-pro-structure-suggestion.service.testutil';

const resultOf = (suggestion: RawStructureSuggestion): StructureAiResult => ({
  suggestion,
  model: 'gpt-6-luna',
  usage: null,
});

/** O exemplo com Carnes na ordem COXA, LINGUICA, PICANHA e a LINGUICA sugerida pelo motor em 2x1 (página 1). */
const carnesRequest = () => {
  const request = exampleRequest({
    suggestedHeroes: [{ itemId: LINGUICA_ID, size: '2x1', page: 1 }],
  });
  request.sections[1].itemIds = [COXA_ID, LINGUICA_ID, PICANHA_ID];
  return request;
};

describe('FlyerProStructureSuggestionService: os campos da versão 2 (Campos da versão 2 na resposta da sugestão)', () => {
  it('Resposta com os campos novos: a ordem de Carnes com ids reais, o desfazer da LINGUICA e a campanha simulada', async () => {
    const { service } = makeSuggestionService({
      document: documentRow({ name: 'Teste #ia-sem-sugeridos #ia-desconto' }),
    });

    const view = await service.suggest(DOCUMENT_ID, bodyOf(carnesRequest()));

    const carnes = view.sections.find((section) => section.id === 'cat:Carnes');
    expect(carnes).toMatchObject({
      itemIds: [PICANHA_ID, COXA_ID, LINGUICA_ID],
      itemsReason: expect.stringMatching(/^\[simulado\] /),
    });
    const others = view.sections.filter((section) => section.id !== 'cat:Carnes');
    expect(others.map((section) => section.itemIds)).toEqual([null, null]);
    expect(view.unsuggest).toEqual([
      { itemId: LINGUICA_ID, reason: expect.stringMatching(/^\[simulado\] /) },
    ]);
    expect(view.campaign).toEqual({ kind: 'discount', label: '[simulado] desconto' });
    expect(view.promptVersion).toBe(2);
  });

  it('Seção esquecida pela IA: o provedor devolve só s3 e s2, e Hortifruti vem no fim com page nulo, motivo vazio e sem ordem', async () => {
    const { port } = fakePort(
      resultOf({ ...EMPTY_RAW_SUGGESTION, sections: [rawSection('s3'), rawSection('s2')] }),
    );
    const { service } = makeSuggestionService({ port });

    const view = await service.suggest(DOCUMENT_ID, bodyOf());

    expect(view.sections.map((section) => section.id)).toEqual([
      'cat:Bebidas',
      'cat:Carnes',
      'cat:Hortifruti',
    ]);
    expect(view.sections[2]).toEqual({
      id: 'cat:Hortifruti',
      page: null,
      reason: '',
      itemIds: null,
      itemsReason: '',
    });
  });

  it('Ids reais, nunca apelidos: a ordem de Carnes e o unsuggest voltam com os UUIDs, e nenhum campo traz p01 a p08', async () => {
    const { port } = fakePort(
      resultOf({
        ...EMPTY_RAW_SUGGESTION,
        sections: [
          rawSection('s1'),
          rawSection('s2', null, '', {
            items: ['p06', 'p04', 'p05'],
            itemsReason: 'Linguiça puxa.',
          }),
          rawSection('s3'),
        ],
        unsuggest: [rawUnsuggest('p05', 'Pouco apelo.')],
      }),
    );
    const { service } = makeSuggestionService({ port });
    const body = bodyOf({ suggestedHeroes: [{ itemId: COXA_ID, size: '2x1', page: 1 }] });

    const view = await service.suggest(DOCUMENT_ID, body);

    const carnes = view.sections.find((section) => section.id === 'cat:Carnes');
    expect(carnes?.itemIds).toEqual([LINGUICA_ID, PICANHA_ID, COXA_ID]);
    expect(view.unsuggest).toEqual([{ itemId: COXA_ID, reason: 'Pouco apelo.' }]);
    expect(JSON.stringify(view)).not.toMatch(/"p0[1-8]"/);
  });
});

describe('FlyerProStructureSuggestionService: suggestedHeroes no pedido (Sugeridos do motor no pedido da sugestão)', () => {
  const aiRequestFor = async (body: ReturnType<typeof bodyOf>) => {
    const { port, suggest } = fakePort(resultOf(EMPTY_RAW_SUGGESTION));
    const { service } = makeSuggestionService({ port });
    const view = await service.suggest(DOCUMENT_ID, body);
    return { view, aiRequest: suggest.mock.calls[0][0] };
  };

  it('Pedido sem o campo: o pedido ao provedor não marca nenhum produto como sugerido do motor', async () => {
    const { aiRequest } = await aiRequestFor(bodyOf());

    expect(aiRequest.items.every((item) => item.suggestedHero === null)).toBe(true);
    expect(aiRequest.pages.map((page) => page.suggestedCells)).toEqual([0, 0]);
  });

  it('Sugerido no pedido chega ao provedor: a COXA (p05) vai como sugerida em 2x1 e a página 1 com 1 célula', async () => {
    const { aiRequest } = await aiRequestFor(
      bodyOf({ suggestedHeroes: [{ itemId: COXA_ID, size: '2x1', page: 1 }] }),
    );

    expect(aiRequest.items.find((item) => item.alias === 'p05')?.suggestedHero).toBe('2x1');
    expect(aiRequest.pages.map((page) => page.suggestedCells)).toEqual([1, 0]);
  });

  it('Sugerido que não é item do encarte: o UUID de outro encarte é ignorado, a resposta é 200 e basedOn.items continua 8', async () => {
    const { view, aiRequest } = await aiRequestFor(
      bodyOf({ suggestedHeroes: [{ itemId: randomUUID(), size: '2x2', page: 1 }] }),
    );

    expect(view.basedOn.items).toBe(8);
    expect(aiRequest.items.every((item) => item.suggestedHero === null)).toBe(true);
  });

  it('sugerido repetido ou em página que não existe é 422 e o provedor não é chamado', async () => {
    const { port, suggest } = fakePort(resultOf(EMPTY_RAW_SUGGESTION));
    const { service } = makeSuggestionService({ port });
    const twice = { itemId: COXA_ID, size: '2x1' as const, page: 1 };

    await expect(
      service.suggest(DOCUMENT_ID, bodyOf({ suggestedHeroes: [twice, twice] })),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'FLYER_PRO_STRUCTURE_STATE_INVALID',
        issues: [{ field: 'suggestedHeroes', code: 'ITEM_DUPLICATED' }],
      },
    });
    await expect(
      service.suggest(DOCUMENT_ID, bodyOf({ suggestedHeroes: [{ ...twice, page: 3 }] })),
    ).rejects.toMatchObject({
      response: { issues: [{ field: 'suggestedHeroes', code: 'PAGES_MISMATCH' }] },
    });
    expect(suggest).not.toHaveBeenCalled();
  });
});
