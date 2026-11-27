import { clipText } from './structure-suggestion-discard';
import { sanitizeSuggestion } from './structure-suggestion-sanitize';
import {
  discardedCodes,
  rawHero,
  rawSection,
  rawSuggestion,
  sanitizeContext,
  sectionIds,
} from './structure-suggestion-sanitize.testutil';
import { exampleRequest } from './structure-suggestion.testutil';

describe('sanitizeSuggestion: textos e proposta sem mudança (S13 e S14)', () => {
  it('Textos longos: summary de 420 caracteres sai com 300, reason e itemsReason de 200 saem com 160, sem reticências', () => {
    const raw = rawSuggestion({
      summary: 'a'.repeat(420),
      sections: [
        rawSection('s1', null, 'b'.repeat(200)),
        rawSection('s2', null, '', { items: ['p06', 'p04', 'p05'], itemsReason: 'd'.repeat(200) }),
        rawSection('s3'),
      ],
      heroes: [rawHero('p04', '2x1', 'c'.repeat(200))],
    });
    const result = sanitizeSuggestion(raw, sanitizeContext());
    expect(result.summary).toBe('a'.repeat(300));
    expect(result.sections[0].reason).toBe('b'.repeat(160));
    expect(result.sections[1].itemsReason).toBe('d'.repeat(160));
    expect(result.heroes[0].reason).toBe('c'.repeat(160));
  });

  it('S13: textos aparados antes de cortar e summary vazio é aceito', () => {
    const raw = rawSuggestion({
      summary: '   ',
      sections: [rawSection('s1', null, '  ok  '), rawSection('s2'), rawSection('s3')],
    });
    const result = sanitizeSuggestion(raw, sanitizeContext());
    expect(result.summary).toBe('');
    expect(result.sections[0].reason).toBe('ok');
  });

  it('Só a campanha lida: a ordem do pedido, nada mais a mudar e a campanha de desconto é noChange true, com a campanha', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ campaign: { kind: 'discount', label: 'Black Friday' } }),
      sanitizeContext(),
    );
    expect(result.noChange).toBe(true);
    expect(result.campaign).toEqual({ kind: 'discount', label: 'Black Friday' });
  });

  it('clipText corta por pontos de código, sem partir um emoji ao meio', () => {
    expect(clipText('😀😀😀', 2)).toBe('😀😀');
    expect(clipText(undefined, 5)).toBe('');
  });

  it('S14: a ordem do pedido devolvida, sem destaque, é noChange, com a fixada de Bebidas', () => {
    const result = sanitizeSuggestion(rawSuggestion(), sanitizeContext());
    expect(result.noChange).toBe(true);
    expect(sectionIds(result)).toEqual(['cat:Hortifruti', 'cat:Carnes', 'cat:Bebidas']);
    expect(result.sections[2].page).toBe(2);
  });

  it('S14: Hortifruti com page 1, onde já está sozinha, não é mudança', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1', 1), rawSection('s2'), rawSection('s3')] }),
      sanitizeContext(),
    );
    expect(result.noChange).toBe(true);
  });

  it('S14: página diferente da única em que a seção está é mudança', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1', 2), rawSection('s2'), rawSection('s3')] }),
      sanitizeContext(),
    );
    expect(result.noChange).toBe(false);
  });

  it('S14: seção que está em mais de uma página com página proposta é mudança', () => {
    const request = exampleRequest();
    request.sections[0].pages = [1, 2];
    const result = sanitizeSuggestion(
      rawSuggestion({ sections: [rawSection('s1', 1), rawSection('s2'), rawSection('s3')] }),
      sanitizeContext(request),
    );
    expect(result.noChange).toBe(false);
  });

  it('S14: outra ordem é mudança, e destaque novo também', () => {
    expect(
      sanitizeSuggestion(
        rawSuggestion({ sections: [rawSection('s2'), rawSection('s1'), rawSection('s3')] }),
        sanitizeContext(),
      ).noChange,
    ).toBe(false);
    expect(
      sanitizeSuggestion(rawSuggestion({ heroes: [rawHero('p04')] }), sanitizeContext()).noChange,
    ).toBe(false);
  });

  it('S14: só sobrou lixo (a ordem do pedido e destaques sem foto) é noChange, com as entradas', () => {
    const result = sanitizeSuggestion(
      rawSuggestion({ heroes: [rawHero('p03'), rawHero('p99')] }),
      sanitizeContext(),
    );
    expect(result.noChange).toBe(true);
    expect(discardedCodes(result)).toEqual(['hero:UNKNOWN_ITEM', 'hero:HERO_WITHOUT_PHOTO']);
  });

  it('S14: seção esquecida na ordem do pedido continua sendo noChange, e fora de ordem não', () => {
    expect(
      sanitizeSuggestion(
        rawSuggestion({ sections: [rawSection('s1'), rawSection('s2')] }),
        sanitizeContext(),
      ).noChange,
    ).toBe(true);
    expect(
      sanitizeSuggestion(
        rawSuggestion({ sections: [rawSection('s3'), rawSection('s2')] }),
        sanitizeContext(),
      ).noChange,
    ).toBe(false);
  });
});
