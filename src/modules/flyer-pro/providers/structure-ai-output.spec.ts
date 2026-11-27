import { parseStructureOutput } from './structure-ai-output';
import { outputWith, VALID_OUTPUT } from './flyer-pro-structure-ai.testutil';

const section = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  page: null,
  reason: '',
  items: null,
  itemsReason: '',
  ...over,
});

describe('parseStructureOutput: a saída da versão 2 contra o schema fechado', () => {
  it('uma saída válida volta igual, com campanha, ordem de produtos e sugeridos a desfazer', () => {
    const output = {
      ...VALID_OUTPUT,
      campaign: { kind: 'discount', label: 'Black Friday' },
      sections: [
        section({ id: 's2', items: ['p06', 'p04', 'p05'], itemsReason: 'Linguiça puxa.' }),
      ],
      unsuggest: [{ item: 'p05', reason: 'Pouco apelo.' }],
    };
    expect(parseStructureOutput(JSON.stringify(output))).toEqual(output);
  });

  it('items nulo e items vazio são aceitos (a conferência de cada um é do saneamento)', () => {
    expect(parseStructureOutput(outputWith({ sections: [section({ items: [] })] }))).toBeDefined();
    expect(
      parseStructureOutput(outputWith({ sections: [section({ items: null })] })),
    ).toBeDefined();
  });

  it.each([
    ['Saída no formato da versão 1', '{"summary":"","sections":[],"heroes":[]}'],
    ['Campo a mais na saída: pages na raiz', outputWith({ pages: 3 })],
    ['Página a mais na saída: pageCount na raiz', outputWith({ pageCount: 3 })],
    [
      'Divisão de seção na saída: split numa seção',
      outputWith({ sections: [section({ split: 2 })] }),
    ],
    ['Tipo de campanha fora da lista', outputWith({ campaign: { kind: 'natal', label: 'Natal' } })],
    ['campanha sem label', outputWith({ campaign: { kind: 'none' } })],
    ['campanha com campo a mais', outputWith({ campaign: { kind: 'none', label: '', x: 1 } })],
    ['campanha nula', outputWith({ campaign: null })],
    [
      'seção sem items (formato da versão 1)',
      outputWith({ sections: [{ id: 's1', page: null, reason: '' }] }),
    ],
    [
      'seção sem itemsReason',
      outputWith({ sections: [{ id: 's1', page: null, reason: '', items: null }] }),
    ],
    ['items que não é lista', outputWith({ sections: [section({ items: 'p01' })] })],
    [
      'items com apelido que não é texto',
      outputWith({ sections: [section({ items: ['p01', 2] })] }),
    ],
    ['itemsReason que não é texto', outputWith({ sections: [section({ itemsReason: 3 })] })],
    ['sem unsuggest', JSON.stringify({ ...VALID_OUTPUT, unsuggest: undefined })],
    ['unsuggest sem reason', outputWith({ unsuggest: [{ item: 'p05' }] })],
    [
      'unsuggest com campo a mais',
      outputWith({ unsuggest: [{ item: 'p05', reason: '', size: '2x1' }] }),
    ],
    ['unsuggest que não é lista', outputWith({ unsuggest: 'p05' })],
  ])('%s é INVALID_OUTPUT', (_name, text) => {
    expect(() => parseStructureOutput(text)).toThrow(
      expect.objectContaining({ name: 'StructureAiFailure', reason: 'INVALID_OUTPUT' }),
    );
  });
});
