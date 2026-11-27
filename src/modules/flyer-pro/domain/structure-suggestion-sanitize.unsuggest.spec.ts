import { sanitizeSuggestion } from './structure-suggestion-sanitize';
import {
  discardedCodes,
  rawHero,
  rawSuggestion,
  rawUnsuggest,
  sanitizeContext,
} from './structure-suggestion-sanitize.testutil';
import {
  ABACATE_ID,
  CERVEJA_ID,
  COXA_ID,
  exampleRequest,
  TOMATE_ID,
} from './structure-suggestion.testutil';
import type { RawStructureSuggestion } from './structure-suggestion.types';

/** O exemplo com a COXA E SOBRECOXA DE FRANGO (p05) sugerida pelo motor em 2x1, página 1. */
const coxaSuggested = () =>
  exampleRequest({ suggestedHeroes: [{ itemId: COXA_ID, size: '2x1', page: 1 }] });

const run = (over: Partial<RawStructureSuggestion>, request = coxaSuggested()) =>
  sanitizeSuggestion(rawSuggestion(over), sanitizeContext(request));

describe('sanitizeSuggestion: sugeridos do motor a desfazer (Saneamento dos sugeridos do motor a desfazer)', () => {
  it('Sugerido válido: a COXA vem com o motivo, sem entrada em discarded', () => {
    const result = run({ unsuggest: [rawUnsuggest('p05', 'Pouco apelo.')] });

    expect(result.unsuggest).toEqual([{ itemId: COXA_ID, reason: 'Pouco apelo.' }]);
    expect(result.discarded).toEqual([]);
  });

  it('Não é sugerido do motor: a CERVEJA (p07) fora de suggestedHeroes sai com NOT_SUGGESTED', () => {
    const result = run({ unsuggest: [rawUnsuggest('p07')] });

    expect(result.unsuggest).toEqual([]);
    expect(result.discarded).toEqual([{ kind: 'unsuggest', code: 'NOT_SUGGESTED' }]);
  });

  it('Inventado ou repetido: p99, p05 e p05 deixam só a COXA, com UNKNOWN_ITEM e DUPLICATED, uma entrada cada', () => {
    const result = run({
      unsuggest: [rawUnsuggest('p99'), rawUnsuggest('p05'), rawUnsuggest('p05')],
    });

    expect(result.unsuggest.map((entry) => entry.itemId)).toEqual([COXA_ID]);
    expect(discardedCodes(result)).toEqual(['unsuggest:UNKNOWN_ITEM', 'unsuggest:DUPLICATED']);
  });

  it('Desfazer e destacar o mesmo produto: a COXA fica em heroes (2x2), unsuggest sai vazio, com CONFLICTS_WITH_HERO', () => {
    const result = run({ heroes: [rawHero('p05', '2x2')], unsuggest: [rawUnsuggest('p05')] });

    expect(result.heroes).toEqual([{ itemId: COXA_ID, size: '2x2', reason: '' }]);
    expect(result.unsuggest).toEqual([]);
    expect(discardedCodes(result)).toEqual(['unsuggest:CONFLICTS_WITH_HERO']);
  });

  it('Pedido sem sugeridos: unsuggest com p05 sai com NOT_SUGGESTED, também sem o campo no pedido', () => {
    const request = exampleRequest();
    const result = run({ unsuggest: [rawUnsuggest('p05')] }, request);

    expect(request.suggestedHeroes).toBeUndefined();
    expect(result.unsuggest).toEqual([]);
    expect(discardedCodes(result)).toEqual(['unsuggest:NOT_SUGGESTED']);
  });

  it('o destaque que o saneamento dos destaques tirou não conflita: o TOMATE sem foto sai de heroes e o desfazer dele fica', () => {
    const request = exampleRequest({
      suggestedHeroes: [{ itemId: TOMATE_ID, size: '2x1', page: 1 }],
    });
    const result = run(
      { heroes: [rawHero('p03')], unsuggest: [rawUnsuggest('p03', 'Sem foto.')] },
      request,
    );

    expect(result.heroes).toEqual([]);
    expect(result.unsuggest).toEqual([{ itemId: TOMATE_ID, reason: 'Sem foto.' }]);
    expect(discardedCodes(result)).toEqual(['hero:HERO_WITHOUT_PHOTO']);
  });

  it('as entradas saem na ordem do saneamento: desconhecido, repetido, fora dos sugeridos e em conflito', () => {
    const request = exampleRequest({
      suggestedHeroes: [
        { itemId: COXA_ID, size: '2x1', page: 1 },
        { itemId: ABACATE_ID, size: '2x1', page: 1 },
      ],
    });
    const result = run(
      {
        heroes: [rawHero('p01', '2x2')],
        unsuggest: [
          rawUnsuggest('p01'),
          rawUnsuggest('p07'),
          rawUnsuggest('p05'),
          rawUnsuggest('p05'),
          rawUnsuggest('p99'),
        ],
      },
      request,
    );

    expect(result.unsuggest.map((entry) => entry.itemId)).toEqual([COXA_ID]);
    expect(discardedCodes(result)).toEqual([
      'unsuggest:UNKNOWN_ITEM',
      'unsuggest:DUPLICATED',
      'unsuggest:NOT_SUGGESTED',
      'unsuggest:CONFLICTS_WITH_HERO',
    ]);
  });

  it('o motivo é aparado e cortado em 160 caracteres, sem reticências', () => {
    const result = run({ unsuggest: [rawUnsuggest('p05', `  ${'x'.repeat(200)}  `)] });

    expect(result.unsuggest[0].reason).toBe('x'.repeat(160));
  });

  it('Só um sugerido a desfazer: noChange é false', () => {
    expect(run({ unsuggest: [rawUnsuggest('p05')] }).noChange).toBe(false);
    expect(run({ unsuggest: [rawUnsuggest('p07')] }).noChange).toBe(true);
  });

  it('a CERVEJA proposta em unsuggest sem estar sugerida não vira destaque nem some do pedido', () => {
    const request = exampleRequest({
      suggestedHeroes: [{ itemId: CERVEJA_ID, size: '2x2', page: 2 }],
    });
    const result = run({ unsuggest: [rawUnsuggest('p07')] }, request);

    expect(result.unsuggest.map((entry) => entry.itemId)).toEqual([CERVEJA_ID]);
    expect(result.heroes).toEqual([]);
  });
});
