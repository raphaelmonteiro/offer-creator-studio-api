import { randomUUID } from 'crypto';
import { sanitizeSuggestion } from './structure-suggestion-sanitize';
import {
  discardedCodes,
  rawSection,
  rawSuggestion,
  sanitizeContext,
} from './structure-suggestion-sanitize.testutil';
import {
  ABACATE_ID,
  BANANA_ID,
  COXA_ID,
  exampleRequest,
  LINGUICA_ID,
  PICANHA_ID,
  TOMATE_ID,
} from './structure-suggestion.testutil';
import type { RawStructureSuggestion } from './structure-suggestion.types';

/** O exemplo: Hortifruti é s1 (p01 a p03), Carnes é s2 (p04 PICANHA, p05 COXA, p06 LINGUICA) e Bebidas é s3 (p07 e p08). */
const withCarnes = (items: string[] | null, itemsReason = '') =>
  rawSuggestion({
    sections: [
      rawSection('s1'),
      rawSection('s2', null, '', { items, itemsReason }),
      rawSection('s3'),
    ],
  });

const carnesOf = (raw: RawStructureSuggestion) => {
  const result = sanitizeSuggestion(raw, sanitizeContext());
  return { result, carnes: result.sections.find((section) => section.id === 'cat:Carnes') };
};

describe('sanitizeSuggestion: a ordem dos produtos da resposta (Saneamento da ordem dos produtos da resposta)', () => {
  it('Ordem completa de uma seção: vira os ids reais na ordem proposta, com o motivo, sem entrada em discarded', () => {
    const { result, carnes } = carnesOf(
      withCarnes(['p06', 'p04', 'p05'], 'Linguiça puxa o churrasco.'),
    );

    expect(carnes).toEqual({
      id: 'cat:Carnes',
      page: null,
      reason: '',
      itemIds: [LINGUICA_ID, PICANHA_ID, COXA_ID],
      itemsReason: 'Linguiça puxa o churrasco.',
    });
    expect(result.discarded).toEqual([]);
  });

  it('Faltou produto: itemIds nulo e uma entrada ITEMS_MISMATCH', () => {
    const { result, carnes } = carnesOf(withCarnes(['p04', 'p05'], 'motivo sem ordem'));

    expect(carnes).toMatchObject({ itemIds: null, itemsReason: '' });
    expect(discardedCodes(result)).toEqual(['itemOrder:ITEMS_MISMATCH']);
  });

  it.each([
    ['produto de outra seção (p01)', ['p04', 'p05', 'p06', 'p01']],
    ['produto repetido', ['p04', 'p05', 'p06', 'p05']],
    ['mesmo tamanho com repetição', ['p04', 'p04', 'p05']],
    ['apelido inventado (p99)', ['p04', 'p05', 'p99']],
    ['do mesmo tamanho, com um de outra seção no lugar', ['p04', 'p05', 'p01']],
    ['lista vazia numa seção com produtos', []],
  ])(
    'Produto de outra seção, repetido ou inventado: %s é ITEMS_MISMATCH e as outras seções não mudam',
    (_name, items) => {
      const { result, carnes } = carnesOf(withCarnes(items));

      expect(carnes).toMatchObject({ itemIds: null, itemsReason: '' });
      expect(discardedCodes(result)).toEqual(['itemOrder:ITEMS_MISMATCH']);
      expect(result.sections.map((section) => section.itemIds)).toEqual([null, null, null]);
    },
  );

  it('Mesma ordem do pedido: itemIds nulo, sem entrada em discarded e sem o motivo', () => {
    const { result, carnes } = carnesOf(withCarnes(['p04', 'p05', 'p06'], 'Igual à de hoje.'));

    expect(carnes).toMatchObject({ itemIds: null, itemsReason: '' });
    expect(result.discarded).toEqual([]);
  });

  it('items nulo vale manter, sem entrada, e o motivo sem ordem não vai na resposta', () => {
    const { result, carnes } = carnesOf(withCarnes(null, 'Motivo de uma ordem que não veio.'));

    expect(carnes).toMatchObject({ itemIds: null, itemsReason: '' });
    expect(result.discarded).toEqual([]);
  });

  it('Id ignorado no pedido não falta na ordem: o UUID que não é item de nenhum encarte não ganhou apelido', () => {
    const request = exampleRequest();
    request.sections[1].itemIds = [PICANHA_ID, randomUUID(), COXA_ID, LINGUICA_ID];
    const raw = withCarnes(['p06', 'p04', 'p05']);

    const result = sanitizeSuggestion(raw, sanitizeContext(request));

    expect(result.sections.find((section) => section.id === 'cat:Carnes')?.itemIds).toEqual([
      LINGUICA_ID,
      PICANHA_ID,
      COXA_ID,
    ]);
    expect(result.discarded).toEqual([]);
  });

  it('Ordem do bloco de soltos: o bloco não aparece em sections e discarded não traz entrada por ele', () => {
    const request = exampleRequest();
    request.sections.push({ id: 'loose', itemIds: [ABACATE_ID], cells: 1, pages: [2] });
    request.sections[0].itemIds = [BANANA_ID, TOMATE_ID];
    const raw = rawSuggestion({
      sections: [
        rawSection('s1'),
        rawSection('s2'),
        rawSection('s3'),
        rawSection('s4', null, '', { items: ['p06', 'p05'], itemsReason: 'soltos' }),
      ],
    });

    const result = sanitizeSuggestion(raw, sanitizeContext(request));

    expect(result.sections.map((section) => section.id)).toEqual([
      'cat:Hortifruti',
      'cat:Carnes',
      'cat:Bebidas',
    ]);
    expect(result.discarded).toEqual([]);
  });

  it('A seção que a IA esqueceu vem no fim com itemIds nulo e itemsReason vazio, e a ordem das outras segue valendo', () => {
    const raw = rawSuggestion({
      sections: [rawSection('s3'), rawSection('s2', null, '', { items: ['p06', 'p04', 'p05'] })],
    });

    const result = sanitizeSuggestion(raw, sanitizeContext());

    expect(result.sections.map((section) => [section.id, section.itemIds])).toEqual([
      ['cat:Bebidas', null],
      ['cat:Carnes', [LINGUICA_ID, PICANHA_ID, COXA_ID]],
      ['cat:Hortifruti', null],
    ]);
    expect(result.sections[2]).toMatchObject({ reason: '', itemsReason: '' });
  });

  it('a seção repetida pela IA vale pela primeira vez: a ordem da segunda sai junto com ela (DUPLICATED)', () => {
    const raw = rawSuggestion({
      sections: [
        rawSection('s1'),
        rawSection('s2', null, '', { items: ['p06', 'p04', 'p05'] }),
        rawSection('s2', null, '', { items: ['p05', 'p04', 'p06'] }),
        rawSection('s3'),
      ],
    });

    const result = sanitizeSuggestion(raw, sanitizeContext());

    expect(result.sections.find((section) => section.id === 'cat:Carnes')?.itemIds).toEqual([
      LINGUICA_ID,
      PICANHA_ID,
      COXA_ID,
    ]);
    expect(discardedCodes(result)).toEqual(['section:DUPLICATED']);
  });

  it('as entradas de itemOrder vêm depois das de seção e de página e antes das de destaque, uma por seção descartada', () => {
    const raw = rawSuggestion({
      sections: [
        rawSection('s7'),
        rawSection('s1', null, '', { items: ['p01'] }),
        rawSection('s2', 9, '', { items: ['p04', 'p05'] }),
        rawSection('s3'),
      ],
      heroes: [{ item: 'p99', size: '2x1', reason: '' }],
    });

    const result = sanitizeSuggestion(raw, sanitizeContext());

    expect(discardedCodes(result)).toEqual([
      'section:UNKNOWN_SECTION',
      'page:PAGE_OUT_OF_RANGE',
      'itemOrder:ITEMS_MISMATCH',
      'itemOrder:ITEMS_MISMATCH',
      'hero:UNKNOWN_ITEM',
    ]);
  });

  it('Só a ordem dos produtos mudou: noChange é false, e a ordem igual à do pedido segue noChange true', () => {
    expect(sanitizeSuggestion(withCarnes(['p06', 'p04', 'p05']), sanitizeContext()).noChange).toBe(
      false,
    );
    expect(sanitizeSuggestion(withCarnes(['p04', 'p05', 'p06']), sanitizeContext()).noChange).toBe(
      true,
    );
    expect(sanitizeSuggestion(withCarnes(['p04', 'p05']), sanitizeContext()).noChange).toBe(true);
  });
});
