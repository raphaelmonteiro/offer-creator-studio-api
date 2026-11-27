import { exampleAiRequest } from '../domain/structure-ai-request.testutil';
import {
  ABACATE_ID,
  BANANA_ID,
  COXA_ID,
  exampleRequest,
  LINGUICA_ID,
  PICANHA_ID,
} from '../domain/structure-suggestion.testutil';
import type { SanitizedSuggestion, StructureRequest } from '../domain/structure-suggestion.types';
import { StructureAiFailure } from './flyer-pro-structure-ai.port';
import { makeMock, suggestionFor } from './flyer-pro-structure-ai.testutil';

/** O exemplo com Carnes na ordem COXA, LINGUICA, PICANHA (a PICANHA, de/por, é a última). */
const carnesWithPicanhaLast = (over: Partial<StructureRequest> = {}) => {
  const request = exampleRequest(over);
  request.sections[1].itemIds = [COXA_ID, LINGUICA_ID, PICANHA_ID];
  return request;
};

const carnesOf = (result: SanitizedSuggestion) =>
  result.sections.find((section) => section.id === 'cat:Carnes');

describe('MockFlyerProStructureAi: a regra da versão 2 (Provedor simulado na versão 2)', () => {
  it('Ordem do simulado numa seção: os de/por primeiro e depois os outros, cada grupo na ordem do pedido, com o motivo [simulado]', async () => {
    const result = await suggestionFor('Ofertas da semana 47', carnesWithPicanhaLast());

    expect(carnesOf(result)).toMatchObject({
      itemIds: [PICANHA_ID, COXA_ID, LINGUICA_ID],
      itemsReason: '[simulado] De/por primeiro.',
    });
  });

  it('Seção sem de/por: Hortifruti e Bebidas vêm com itemIds nulo, unsuggest é [] e campaign é null', async () => {
    const result = await suggestionFor('Ofertas da semana 47');

    const others = result.sections.filter((section) => section.id !== 'cat:Carnes');
    expect(others.map((section) => [section.itemIds, section.itemsReason])).toEqual([
      [null, ''],
      [null, ''],
    ]);
    expect(result.unsuggest).toEqual([]);
    expect(result.campaign).toBeNull();
  });

  it('a PICANHA já primeira em Carnes não gera ordem: itemIds nulo e motivo vazio, sem entrada em discarded', async () => {
    const result = await suggestionFor('Ofertas da semana 47');

    expect(carnesOf(result)).toMatchObject({ itemIds: null, itemsReason: '' });
    expect(result.discarded).toEqual([]);
  });

  it('a ordem nova dos produtos de Carnes é mudança: noChange é false mesmo sem destaque nem página nova', async () => {
    const result = await suggestionFor('Ofertas da semana 47', carnesWithPicanhaLast());

    expect(result.noChange).toBe(false);
    expect(carnesOf(result)?.itemIds).not.toBeNull();
  });
});

describe('MockFlyerProStructureAi: os marcadores novos (Marcadores do provedor simulado na versão 2)', () => {
  const suggested = (...ids: string[]) =>
    ids.map((itemId) => ({ itemId, size: '2x1' as const, page: 1 }));

  it('Desfazer todos os sugeridos: #ia-sem-sugeridos põe em unsuggest o ABACATE e a COXA, na ordem do pedido, e noChange é false', async () => {
    const request = exampleRequest({ suggestedHeroes: suggested(COXA_ID, ABACATE_ID) });

    const result = await suggestionFor('Teste #ia-sem-sugeridos', request);

    expect(result.unsuggest.map((entry) => entry.itemId)).toEqual([ABACATE_ID, COXA_ID]);
    expect(result.unsuggest.every((entry) => entry.reason.startsWith('[simulado] '))).toBe(true);
    expect(result.noChange).toBe(false);
  });

  it('#ia-sem-sugeridos não propõe como destaque o que desfaz: nenhum CONFLICTS_WITH_HERO, e o destaque passa ao próximo item com foto', async () => {
    const request = exampleRequest({ suggestedHeroes: suggested(COXA_ID, ABACATE_ID) });

    const result = await suggestionFor('Teste #ia-sem-sugeridos', request);

    expect(result.discarded).toEqual([]);
    expect(result.heroes.map((hero) => hero.itemId)).toEqual([PICANHA_ID, BANANA_ID]);
  });

  it('#ia-sem-sugeridos sem sugeridos no pedido não desfaz nada', async () => {
    const result = await suggestionFor('Teste #ia-sem-sugeridos');

    expect(result.unsuggest).toEqual([]);
  });

  it('Campanhas simuladas: #ia-categoria devolve a de categoria e #ia-categoria com #ia-desconto devolve a de desconto', async () => {
    const category = await suggestionFor('Teste #ia-categoria');
    const both = await suggestionFor('Teste #ia-categoria #ia-desconto');
    const discount = await suggestionFor('Teste #ia-desconto');

    expect(category.campaign).toEqual({ kind: 'category', label: '[simulado] categoria' });
    expect(both.campaign).toEqual({ kind: 'discount', label: '[simulado] desconto' });
    expect(discount.campaign).toEqual({ kind: 'discount', label: '[simulado] desconto' });
  });

  it('a campanha simulada não conta como mudança: sem ordem de produtos nem sugeridos, #ia-desconto sozinho continua com as mudanças da tabela', async () => {
    const result = await suggestionFor('Teste #ia-desconto');

    expect(result.noChange).toBe(false);
    expect(result.heroes).toHaveLength(2);
  });

  it('Igual vence as mudanças da versão 2: #ia-igual com #ia-sem-sugeridos e #ia-desconto traz noChange, todo itemIds nulo, unsuggest [] e campaign null', async () => {
    const request = carnesWithPicanhaLast({ suggestedHeroes: suggested(COXA_ID) });

    const result = await suggestionFor('Teste #ia-igual #ia-sem-sugeridos #ia-desconto', request);

    expect(result.noChange).toBe(true);
    expect(result.sections.map((section) => section.itemIds)).toEqual([null, null, null]);
    expect(result.unsuggest).toEqual([]);
    expect(result.campaign).toBeNull();
  });

  it('Falha vence todos: #ia-falha com #ia-desconto (e os outros) é PROVIDER_ERROR', async () => {
    const { mock } = makeMock();

    await expect(
      mock.suggest(
        exampleAiRequest({
          documentName: 'Teste #ia-desconto #ia-falha #ia-sem-sugeridos #ia-igual',
        }),
        { timeoutMs: 25_000 },
      ),
    ).rejects.toThrow(expect.objectContaining({ reason: 'PROVIDER_ERROR' }));
    await expect(
      mock.suggest(exampleAiRequest({ documentName: 'Teste #ia-falha' }), { timeoutMs: 25_000 }),
    ).rejects.toBeInstanceOf(StructureAiFailure);
  });
});
