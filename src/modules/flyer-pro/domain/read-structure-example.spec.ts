import {
  pickDeliberateExamples,
  readStructureExample,
  type StructureExampleRow,
} from './read-structure-example';

const sectionList = (...ids: string[]) => ids.map((id) => ({ id }));
const parts = (...pages: number[]) => ({ parts: pages.map((page) => ({ page })) });

/** O encarte anterior do cliente: folha simples 27x40 com 2 páginas, Carnes (1), Hortifruti (1), Mercearia (2), Bebidas (2). */
const row = (over: Partial<StructureExampleRow> = {}): StructureExampleRow => ({
  format: '27x40',
  pageCount: 2,
  schemaVersion: 1,
  structure: {
    sections: sectionList('cat:Carnes', 'cat:Hortifruti', 'cat:Mercearia', 'cat:Bebidas'),
    plan: {
      'cat:Carnes': parts(1),
      'cat:Hortifruti': parts(1),
      'cat:Mercearia': parts(2),
      'cat:Bebidas': parts(2),
    },
  },
  ...over,
});

const withStructure = (structure: unknown) => row({ structure });
const categoryOrder = (...ids: string[]) =>
  withStructure({ sections: sectionList(...ids.map((id) => `cat:${id}`)) });

describe('readStructureExample: o encarte anterior do cliente', () => {
  it('fatia válida: formato, páginas, sequência das categorias e a primeira página de cada uma', () => {
    expect(readStructureExample(row())).toEqual({
      format: '27x40',
      pageCount: 2,
      sections: [
        { category: 'Carnes', page: 1 },
        { category: 'Hortifruti', page: 1 },
        { category: 'Mercearia', page: 2 },
        { category: 'Bebidas', page: 2 },
      ],
      deliberate: true,
    });
  });

  it('seção dividida: a primeira página é a menor das partes, mesmo com a 2 antes da 1', () => {
    const structure = {
      sections: sectionList('cat:Carnes', 'cat:Bebidas'),
      plan: { 'cat:Carnes': parts(2, 1), 'cat:Bebidas': parts(3, 2) },
    };
    expect(readStructureExample(withStructure(structure))?.sections).toEqual([
      { category: 'Carnes', page: 1 },
      { category: 'Bebidas', page: 2 },
    ]);
  });

  it('seção sem entrada no plano (ou sem partes úteis) fica sem página, e o loose não entra na sequência', () => {
    const structure = {
      sections: sectionList('cat:Carnes', 'cat:Bebidas', 'loose'),
      plan: { 'cat:Carnes': parts(1), 'cat:Bebidas': { parts: [{ page: 'x' }, {}, null] } },
    };
    expect(readStructureExample(withStructure(structure))?.sections).toEqual([
      { category: 'Carnes', page: 1 },
      { category: 'Bebidas', page: null },
    ]);
    const semPlano = { sections: sectionList('cat:Carnes', 'cat:Bebidas', 'loose') };
    expect(readStructureExample(withStructure(semPlano))?.sections).toEqual([
      { category: 'Carnes', page: null },
      { category: 'Bebidas', page: null },
    ]);
  });

  it('plano em forma estranha não derruba a leitura: as seções ficam sem página', () => {
    for (const plan of [
      'texto',
      7,
      null,
      [],
      { 'cat:Carnes': 'x' },
      { 'cat:Carnes': { parts: 'x' } },
    ]) {
      const structure = { sections: sectionList('cat:Carnes', 'cat:Bebidas'), plan };
      expect(readStructureExample(withStructure(structure))?.sections.map((s) => s.page)).toEqual([
        null,
        null,
      ]);
    }
  });

  it.each([
    ['fatia vazia', {}],
    ['sections como texto', { sections: 'Carnes,Hortifruti' }],
    ['sections como objeto', { sections: { id: 'cat:Carnes' } }],
    ['seção que não é objeto', { sections: ['cat:Carnes', 'cat:Bebidas'] }],
    ['seção sem id', { sections: [{ id: 'cat:Carnes' }, { title: 'Bebidas' }] }],
    ['id que não é texto', { sections: [{ id: 'cat:Carnes' }, { id: 7 }] }],
    ['só o bloco de soltos', { sections: sectionList('loose') }],
    ['só ids sem o prefixo cat:', { sections: sectionList('Carnes', 'cat:') }],
    ['sections vazio', { sections: [] }],
    ['fatia que não é objeto', 'Carnes'],
    ['fatia nula', null],
    ['fatia que é lista', [1, 2]],
  ])('é pulado sem erro: %s', (_name, structure) => {
    expect(readStructureExample(withStructure(structure))).toBeNull();
  });

  it('schemaVersion maior que 1 é pulado; 1 passa', () => {
    expect(readStructureExample(row({ schemaVersion: 2 }))).toBeNull();
    expect(readStructureExample(row({ schemaVersion: 1 }))).not.toBeNull();
  });

  describe('o que é escolha deliberada', () => {
    it('a ordem das 11 categorias sem structure.suggestion não é deliberada', () => {
      expect(
        readStructureExample(categoryOrder('Hortifruti', 'Carnes', 'Bebidas'))?.deliberate,
      ).toBe(false);
    });

    it('a ordem diferente da ordem das categorias é deliberada', () => {
      expect(
        readStructureExample(categoryOrder('Carnes', 'Hortifruti', 'Bebidas'))?.deliberate,
      ).toBe(true);
    });

    it('structure.suggestion objeto torna deliberada até a ordem das categorias', () => {
      const structure = {
        sections: sectionList('cat:Hortifruti', 'cat:Carnes'),
        suggestion: { id: 'abc', at: '2026-11-17T10:00:00.000Z' },
      };
      expect(readStructureExample(withStructure(structure))?.deliberate).toBe(true);
    });

    it('suggestion nula, lista ou texto não conta', () => {
      for (const suggestion of [null, [], 'sim', 3]) {
        const structure = { sections: sectionList('cat:Hortifruti', 'cat:Carnes'), suggestion };
        expect(readStructureExample(withStructure(structure))?.deliberate).toBe(false);
      }
    });

    it('o bloco de soltos no meio não muda a conta, e categoria fora das 11 vai para o fim', () => {
      expect(
        readStructureExample(
          withStructure({ sections: sectionList('cat:Hortifruti', 'loose', 'cat:Carnes') }),
        )?.deliberate,
      ).toBe(false);
      expect(readStructureExample(categoryOrder('Bebidas', 'Marciana'))?.deliberate).toBe(false);
      expect(readStructureExample(categoryOrder('Marciana', 'Bebidas'))?.deliberate).toBe(true);
    });
  });
});

describe('pickDeliberateExamples: até o limite, na ordem recebida', () => {
  const deliberate = (name: string) =>
    row({ format: name, structure: { sections: sectionList('cat:Carnes', 'cat:Hortifruti') } });
  const inCategoryOrder = row({
    format: 'ordem-das-categorias',
    structure: { sections: sectionList('cat:Hortifruti', 'cat:Carnes') },
  });

  it('só os deliberados e legíveis, do mais recente para o mais antigo', () => {
    const rows = [
      deliberate('a'),
      inCategoryOrder,
      withStructure({ sections: 'Carnes,Hortifruti' }),
      deliberate('b'),
      row({ schemaVersion: 2 }),
    ];
    expect(pickDeliberateExamples(rows, 3).map((example) => example.format)).toEqual(['a', 'b']);
  });

  it('com quatro deliberados e limite 3, ficam os três primeiros da lista recebida', () => {
    const rows = ['a', 'b', 'c', 'd'].map(deliberate);
    expect(pickDeliberateExamples(rows, 3).map((example) => example.format)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('limite 0 não devolve nada e lista vazia também', () => {
    expect(pickDeliberateExamples([deliberate('a')], 0)).toEqual([]);
    expect(pickDeliberateExamples([], 3)).toEqual([]);
  });
});
