import { sanitizeSuggestion } from './structure-suggestion-sanitize';
import {
  discardedCodes,
  rawHero,
  rawSection,
  rawSuggestion,
  sanitizeContext,
  sectionIds,
} from './structure-suggestion-sanitize.testutil';
import { exampleRequest, PICANHA_ID } from './structure-suggestion.testutil';

describe('sanitizeSuggestion: seções (S1 a S4)', () => {
  it('ida e volta: apelidos viram ids reais, com página e destaque no id da PICANHA', () => {
    const raw = rawSuggestion({
      sections: [rawSection('s2', 1, 'abre a capa'), rawSection('s1'), rawSection('s3')],
      heroes: [rawHero('p04', '2x1', 'de/por com foto')],
    });
    const result = sanitizeSuggestion(raw, sanitizeContext());
    expect(result.sections).toEqual([
      { id: 'cat:Carnes', page: 1, reason: 'abre a capa' },
      { id: 'cat:Hortifruti', page: null, reason: '' },
      { id: 'cat:Bebidas', page: 2, reason: '' },
    ]);
    expect(result.heroes).toEqual([{ itemId: PICANHA_ID, size: '2x1', reason: 'de/por com foto' }]);
    expect(result.discarded).toEqual([]);
  });

  it('S1 e S3: seção desconhecida e repetida saem, uma entrada cada, e a primeira posição fica', () => {
    const raw = rawSuggestion({
      sections: ['s9', 's2', 's1', 's2', 's3'].map((id) => rawSection(id)),
    });
    const result = sanitizeSuggestion(raw, sanitizeContext());
    expect(sectionIds(result)).toEqual(['cat:Carnes', 'cat:Hortifruti', 'cat:Bebidas']);
    expect(result.discarded).toEqual([
      { kind: 'section', code: 'UNKNOWN_SECTION' },
      { kind: 'section', code: 'DUPLICATED' },
    ]);
  });

  it('S1: o id real em vez do apelido é seção desconhecida, e Carnes vai para o fim como esquecida', () => {
    const raw = rawSuggestion({
      sections: [rawSection('s1'), rawSection('cat:Carnes'), rawSection('s3')],
    });
    const result = sanitizeSuggestion(raw, sanitizeContext());
    expect(sectionIds(result)).toEqual(['cat:Hortifruti', 'cat:Bebidas', 'cat:Carnes']);
    expect(result.sections[2]).toEqual({ id: 'cat:Carnes', page: null, reason: '' });
    expect(discardedCodes(result)).toEqual(['section:UNKNOWN_SECTION']);
  });

  it('S4: seção esquecida vai para o fim, na ordem do pedido, sem página e sem motivo, e sem entrada', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s3'), rawSection('s2')] }),
      sanitizeContext(),
    );
    expect(result.sections).toEqual([
      { id: 'cat:Bebidas', page: 2, reason: '' },
      { id: 'cat:Carnes', page: null, reason: '' },
      { id: 'cat:Hortifruti', page: null, reason: '' },
    ]);
    expect(result.discarded).toEqual([]);
  });

  it('S4: duas esquecidas voltam na ordem do pedido', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s3')] }),
      sanitizeContext(),
    );
    expect(sectionIds(result)).toEqual(['cat:Bebidas', 'cat:Hortifruti', 'cat:Carnes']);
  });

  it('S2: o bloco de soltos que o modelo devolve sai, sem entrada em discarded', () => {
    const request = exampleRequest({
      sections: [
        { id: 'cat:Hortifruti', itemIds: [], cells: 1, pages: [1] },
        { id: 'cat:Carnes', itemIds: [], cells: 1, pages: [1] },
        { id: 'loose', itemIds: [], cells: 1, pages: [2] },
      ],
    });
    const raw = rawSuggestion({ sections: [rawSection('s3'), rawSection('s2'), rawSection('s1')] });
    const result = sanitizeSuggestion(raw, sanitizeContext(request));
    expect(sectionIds(result)).toEqual(['cat:Carnes', 'cat:Hortifruti']);
    expect(result.discarded).toEqual([]);
  });

  it('o bloco de soltos esquecido nunca volta como seção esquecida, e devolvido duas vezes sai duas vezes', () => {
    const request = exampleRequest({
      sections: [
        { id: 'cat:Hortifruti', itemIds: [], cells: 1, pages: [1] },
        { id: 'cat:Carnes', itemIds: [], cells: 1, pages: [1] },
        { id: 'loose', itemIds: [], cells: 1, pages: [2] },
      ],
    });
    const forgot = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s2')] }),
      sanitizeContext(request),
    );
    expect(sectionIds(forgot)).toEqual(['cat:Carnes', 'cat:Hortifruti']);
    const twice = sanitizeSuggestion(
      rawSuggestion({ sections: ['s3', 's1', 's3', 's2'].map((id) => rawSection(id)) }),
      sanitizeContext(request),
    );
    expect(sectionIds(twice)).toEqual(['cat:Hortifruti', 'cat:Carnes']);
    expect(twice.discarded).toEqual([]);
  });
});

describe('sanitizeSuggestion: páginas (S5 a S7)', () => {
  it('S5: página 9 vira nula, com PAGE_OUT_OF_RANGE', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1', 9), rawSection('s2'), rawSection('s3')] }),
      sanitizeContext(),
    );
    expect(result.sections[0]).toMatchObject({ id: 'cat:Hortifruti', page: null });
    expect(result.discarded).toEqual([{ kind: 'page', code: 'PAGE_OUT_OF_RANGE' }]);
  });

  it.each([0, -1, 3, 1.5])('S5: página %p fora de 1 a 2 vira nula', (page) => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1', page), rawSection('s2'), rawSection('s3')] }),
      sanitizeContext(),
    );
    expect(result.sections[0].page).toBeNull();
    expect(discardedCodes(result)).toEqual(['page:PAGE_OUT_OF_RANGE']);
  });

  it('S6: página diferente da fixada volta a do usuário, com USER_PINNED', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1'), rawSection('s2'), rawSection('s3', 1)] }),
      sanitizeContext(),
    );
    expect(result.sections[2]).toMatchObject({ id: 'cat:Bebidas', page: 2 });
    expect(result.discarded).toEqual([{ kind: 'page', code: 'USER_PINNED' }]);
  });

  it('S6: a mesma página da fixada não gera entrada', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1'), rawSection('s2'), rawSection('s3', 2)] }),
      sanitizeContext(),
    );
    expect(result.sections[2].page).toBe(2);
    expect(result.discarded).toEqual([]);
  });

  it('S7: seção fixada devolvida sem página recebe a do usuário e nenhuma entrada', () => {
    const result = sanitizeSuggestion(rawSuggestion(), sanitizeContext());
    expect(result.sections[2]).toMatchObject({ id: 'cat:Bebidas', page: 2 });
    expect(result.discarded).toEqual([]);
  });

  it('S5 antes de S6: página 9 numa seção fixada vira nula (uma entrada) e volta a fixada sem USER_PINNED', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1'), rawSection('s2'), rawSection('s3', 9)] }),
      sanitizeContext(),
    );
    expect(result.sections[2].page).toBe(2);
    expect(discardedCodes(result)).toEqual(['page:PAGE_OUT_OF_RANGE']);
  });

  it('seção fixada que o modelo esqueceu volta no fim com a página do usuário', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s2'), rawSection('s1')] }),
      sanitizeContext(),
    );
    expect(result.sections[2]).toEqual({ id: 'cat:Bebidas', page: 2, reason: '' });
  });

  it('página de seção que saiu (desconhecida ou repetida) não é conferida', () => {
    const raw = rawSuggestion({
      sections: [
        rawSection('s9', 7),
        rawSection('s1'),
        rawSection('s1', 8),
        rawSection('s2'),
        rawSection('s3'),
      ],
    });
    expect(discardedCodes(sanitizeSuggestion(raw, sanitizeContext()))).toEqual([
      'section:UNKNOWN_SECTION',
      'section:DUPLICATED',
    ]);
  });
});

describe('sanitizeSuggestion: o caso combinado do cartão U4.7', () => {
  it('cada situação da barreira 1 sai com o código certo, na ordem seções, páginas e destaques', () => {
    const request = exampleRequest({ heroes: [{ itemId: PICANHA_ID, size: '2x1' }] });
    const raw = rawSuggestion({
      sections: [
        rawSection('s9'),
        rawSection('s1', 9),
        rawSection('s2'),
        rawSection('s2'),
        rawSection('s3', 1),
      ],
      heroes: [
        rawHero('p99'),
        rawHero('p03'),
        rawHero('p04', '2x1'),
        ...['p01', 'p02', 'p05', 'p06', 'p07', 'p08'].map((p) => rawHero(p)),
      ],
    });
    const result = sanitizeSuggestion(raw, sanitizeContext(request, { maxHeroes: 3 }));
    expect(discardedCodes(result)).toEqual([
      'section:UNKNOWN_SECTION',
      'section:DUPLICATED',
      'page:PAGE_OUT_OF_RANGE',
      'page:USER_PINNED',
      'hero:UNKNOWN_ITEM',
      'hero:HERO_WITHOUT_PHOTO',
      'hero:HERO_ALREADY_SET',
      'hero:HERO_LIMIT',
      'hero:HERO_LIMIT',
      'hero:HERO_LIMIT',
    ]);
    expect(result.heroes).toHaveLength(3);
    expect(result.noChange).toBe(false);
  });
});
