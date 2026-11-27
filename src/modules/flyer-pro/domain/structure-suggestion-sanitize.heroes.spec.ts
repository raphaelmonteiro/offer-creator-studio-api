import { buildAliases } from './structure-suggestion-aliases';
import { sanitizeSuggestion } from './structure-suggestion-sanitize';
import {
  discardedCodes,
  rawHero,
  rawSection,
  rawSuggestion,
  sanitizeContext,
} from './structure-suggestion-sanitize.testutil';
import {
  ABACATE_ID,
  CERVEJA_ID,
  COXA_ID,
  exampleRequest,
  PICANHA_ID,
} from './structure-suggestion.testutil';
import type { RawStructureSuggestion, StructureRequest } from './structure-suggestion.types';

describe('sanitizeSuggestion: destaques (S8 a S12)', () => {
  const withRaw = (heroes: RawStructureSuggestion['heroes'], request?: StructureRequest) =>
    sanitizeSuggestion(rawSuggestion({ heroes }), sanitizeContext(request));

  it('S8: produto inventado (p99) sai, com UNKNOWN_ITEM; o id real em vez do apelido também', () => {
    const result = withRaw([rawHero('p99'), rawHero(PICANHA_ID), rawHero('p04')]);
    expect(result.heroes.map((h) => h.itemId)).toEqual([PICANHA_ID]);
    expect(result.discarded).toEqual([
      { kind: 'hero', code: 'UNKNOWN_ITEM' },
      { kind: 'hero', code: 'UNKNOWN_ITEM' },
    ]);
  });

  it('S9: item repetido fica só na primeira vez', () => {
    const result = withRaw([rawHero('p04', '2x1'), rawHero('p01'), rawHero('p04', '2x2')]);
    expect(result.heroes.map((h) => [h.itemId, h.size])).toEqual([
      [PICANHA_ID, '2x1'],
      ['7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11', '2x1'],
    ]);
    expect(discardedCodes(result)).toEqual(['hero:DUPLICATED']);
  });

  it('S10: destaque no TOMATE, sem foto no banco, sai com HERO_WITHOUT_PHOTO', () => {
    const result = withRaw([rawHero('p03', '2x1')]);
    expect(result.heroes).toEqual([]);
    expect(result.discarded).toEqual([{ kind: 'hero', code: 'HERO_WITHOUT_PHOTO' }]);
  });

  it('S11: a PICANHA que o usuário já tem em 2x1 sai; a CERVEJA em 2x2 fica', () => {
    const request = exampleRequest({ heroes: [{ itemId: PICANHA_ID, size: '2x1' }] });
    const result = withRaw([rawHero('p04', '2x1'), rawHero('p07', '2x2')], request);
    expect(result.heroes.map((h) => h.itemId)).toEqual([CERVEJA_ID]);
    expect(result.discarded).toEqual([{ kind: 'hero', code: 'HERO_ALREADY_SET' }]);
  });

  it('Outro tamanho num destaque do usuário: a PICANHA em 2x2 sai com HERO_USER_SET (o destaque do usuário não muda)', () => {
    const request = exampleRequest({ heroes: [{ itemId: PICANHA_ID, size: '2x1' }] });
    const result = withRaw([rawHero('p04', '2x2')], request);
    expect(result.heroes).toEqual([]);
    expect(result.discarded).toEqual([{ kind: 'hero', code: 'HERO_USER_SET' }]);
  });

  it('o mesmo tamanho do usuário é HERO_ALREADY_SET e outro tamanho é HERO_USER_SET, nesta ordem, uma entrada por destaque', () => {
    const request = exampleRequest({
      heroes: [
        { itemId: PICANHA_ID, size: '2x1' },
        { itemId: CERVEJA_ID, size: '2x1' },
      ],
    });
    const result = withRaw(
      [rawHero('p07', '2x2'), rawHero('p04', '2x1'), rawHero('p05', '2x1')],
      request,
    );
    expect(result.heroes.map((h) => h.itemId)).toEqual([COXA_ID]);
    expect(discardedCodes(result)).toEqual(['hero:HERO_ALREADY_SET', 'hero:HERO_USER_SET']);
  });

  it('o destaque do usuário que sai por HERO_USER_SET não ocupa vaga do teto', () => {
    const request = exampleRequest({ heroes: [{ itemId: PICANHA_ID, size: '2x1' }] });
    const raw = rawSuggestion({ heroes: [rawHero('p04', '2x2'), rawHero('p01'), rawHero('p02')] });
    const result = sanitizeSuggestion(raw, sanitizeContext(request, { maxHeroes: 2 }));
    expect(result.heroes).toHaveLength(2);
    expect(discardedCodes(result)).toEqual(['hero:HERO_USER_SET']);
  });

  describe('os sugeridos do motor (suggestedHeroes)', () => {
    const coxaSuggested = exampleRequest({
      suggestedHeroes: [{ itemId: COXA_ID, size: '2x1', page: 1 }],
    });

    it('Destaque que o motor já mostra: a COXA em 2x1 e o ABACATE em 2x1 ficam, sem entrada em discarded', () => {
      const result = withRaw([rawHero('p05', '2x1'), rawHero('p01', '2x1')], coxaSuggested);
      expect(result.heroes.map((h) => [h.itemId, h.size])).toEqual([
        [COXA_ID, '2x1'],
        [ABACATE_ID, '2x1'],
      ]);
      expect(result.discarded).toEqual([]);
    });

    it('Outro tamanho é mudança: a COXA sugerida em 2x1 e proposta em 2x2 fica, sem entrada em discarded', () => {
      const result = withRaw([rawHero('p05', '2x2')], coxaSuggested);
      expect(result.heroes).toEqual([{ itemId: COXA_ID, size: '2x2', reason: '' }]);
      expect(result.discarded).toEqual([]);
    });
  });

  describe('S12: o teto', () => {
    const many = (count: number) => {
      const ids = Array.from(
        { length: 20 },
        (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      );
      const request = exampleRequest({
        sections: [
          { id: 'cat:Carnes', itemIds: ids, cells: 20, pages: [1] },
          { id: 'cat:Bebidas', itemIds: [], cells: 0, pages: [2] },
        ],
      });
      const context = sanitizeContext(request, {
        aliases: buildAliases(request.sections, new Set(ids)),
        itemsWithPhoto: new Set(ids),
      });
      const heroes = Array.from({ length: count }, (_, i) =>
        rawHero(`p${String(i + 1).padStart(2, '0')}`),
      );
      return sanitizeSuggestion(
        rawSuggestion({ sections: [rawSection('s1'), rawSection('s2')], heroes }),
        context,
      );
    };

    it('15 destaques válidos e distintos: ficam os 12 primeiros, na ordem do provedor, e 3 HERO_LIMIT', () => {
      const result = many(15);
      expect(result.heroes.map((h) => h.itemId.slice(-2))).toEqual(
        Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')),
      );
      expect(discardedCodes(result)).toEqual([
        'hero:HERO_LIMIT',
        'hero:HERO_LIMIT',
        'hero:HERO_LIMIT',
      ]);
    });

    it('12 destaques não geram HERO_LIMIT', () => {
      expect(many(12).discarded).toEqual([]);
    });

    it('o teto de 2 corta o terceiro, contado depois das outras remoções (S8 a S11)', () => {
      const raw = rawSuggestion({
        heroes: [rawHero('p99'), rawHero('p03'), rawHero('p04'), rawHero('p01'), rawHero('p07')],
      });
      const result = sanitizeSuggestion(raw, sanitizeContext(exampleRequest(), { maxHeroes: 2 }));
      expect(result.heroes.map((h) => h.itemId)).toEqual([
        PICANHA_ID,
        '7d0c2a1e-5f3b-4c8e-9a10-2b4d6f8a0c11',
      ]);
      expect(discardedCodes(result)).toEqual([
        'hero:UNKNOWN_ITEM',
        'hero:HERO_WITHOUT_PHOTO',
        'hero:HERO_LIMIT',
      ]);
    });

    it('14 destaques, 2 em itens sem foto e 12 válidos: sem HERO_LIMIT', () => {
      const request = exampleRequest({
        sections: [
          {
            id: 'cat:Carnes',
            itemIds: Array.from(
              { length: 14 },
              (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
            ),
            cells: 14,
            pages: [1],
          },
          { id: 'cat:Bebidas', itemIds: [], cells: 0, pages: [2] },
        ],
      });
      const ids = request.sections[0].itemIds;
      const context = sanitizeContext(request, {
        aliases: buildAliases(request.sections, new Set(ids)),
        itemsWithPhoto: new Set(ids.slice(2)),
      });
      const heroes = ids.map((_, i) => rawHero(`p${String(i + 1).padStart(2, '0')}`));
      const result = sanitizeSuggestion(
        rawSuggestion({ sections: [rawSection('s1'), rawSection('s2')], heroes }),
        context,
      );
      expect(result.heroes).toHaveLength(12);
      expect(discardedCodes(result)).toEqual([
        'hero:HERO_WITHOUT_PHOTO',
        'hero:HERO_WITHOUT_PHOTO',
      ]);
    });
  });
});
