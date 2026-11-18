import { randomUUID } from 'crypto';
import {
  assertStructureBody,
  assertStructureState,
  validateStructureState,
} from './structure-suggestion-rules';
import { ABACATE_ID, exampleRequest, PICANHA_ID } from './structure-suggestion.testutil';
import type { StructureRequest, StructureSectionInput } from './structure-suggestion.types';

const section = (id: string, over: Partial<StructureSectionInput> = {}): StructureSectionInput => ({
  id,
  itemIds: [],
  cells: 0,
  pages: [],
  ...over,
});

const stateOf = (sections: StructureSectionInput[], over: Partial<StructureRequest> = {}) =>
  validateStructureState(exampleRequest({ sections, ...over }));

describe('assertStructureBody: a forma que o DTO não pega', () => {
  it('corpo {} é 400 BAD_REQUEST com a lista dos obrigatórios que faltam, na ordem do contrato', () => {
    expect(() => assertStructureBody({})).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({
          code: 'BAD_REQUEST',
          message:
            'Campos obrigatórios ausentes: stateDigest, pageCount, level, pages, sections, heroes.',
        }),
      }),
    );
  });

  it('só lista o que falta: unplaced nunca é obrigatório e heroes [] vale', () => {
    const { pages, sections } = exampleRequest();
    expect(() =>
      assertStructureBody({
        stateDigest: 'x',
        pageCount: 2,
        level: 2,
        pages,
        sections,
        heroes: [],
      }),
    ).not.toThrow();
    expect(() =>
      assertStructureBody({ stateDigest: 'x', pageCount: 2, level: 2, pages, sections }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ message: expect.stringContaining('heroes.') }),
      }),
    );
  });

  it('a soma dos ids de todas as seções acima de 500 é 400; 500 passa', () => {
    const ids = (count: number) => Array.from({ length: count }, () => randomUUID());
    const body = (a: number, b: number) =>
      exampleRequest({
        sections: [
          section('cat:Carnes', { itemIds: ids(a) }),
          section('cat:Bebidas', { itemIds: ids(b) }),
        ],
      });
    expect(() => assertStructureBody(body(300, 300))).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ code: 'BAD_REQUEST' }),
      }),
    );
    expect(() => assertStructureBody(body(250, 250))).not.toThrow();
    expect(() => assertStructureBody(body(250, 251))).toThrow();
  });
});

describe('validateStructureState: o retrato coerente e os códigos de issues', () => {
  it('o retrato de exemplo é coerente', () => {
    expect(validateStructureState(exampleRequest())).toEqual([]);
  });

  it('o bloco de soltos no fim não é problema e não conta como seção de categoria', () => {
    expect(stateOf([section('cat:Carnes'), section('cat:Bebidas'), section('loose')])).toEqual([]);
    expect(stateOf([section('cat:Carnes'), section('loose')])).toEqual([
      { field: 'sections', code: 'TOO_FEW_SECTIONS' },
    ]);
  });

  it('uma seção só, com ou sem soltos: TOO_FEW_SECTIONS em `sections`', () => {
    const expected = [{ field: 'sections', code: 'TOO_FEW_SECTIONS' }];
    expect(stateOf([section('cat:Hortifruti')])).toEqual(expected);
    expect(stateOf([section('cat:Hortifruti'), section('loose')])).toEqual(expected);
  });

  it('soltos no meio: LOOSE_NOT_LAST', () => {
    expect(stateOf([section('cat:Hortifruti'), section('loose'), section('cat:Carnes')])).toEqual([
      { field: 'sections', code: 'LOOSE_NOT_LAST' },
    ]);
  });

  it('item em duas seções ou duas vezes na mesma seção: ITEM_DUPLICATED na seção da repetição', () => {
    const crossed = stateOf([
      section('cat:Carnes', { itemIds: [PICANHA_ID] }),
      section('cat:Hortifruti', { itemIds: [ABACATE_ID, PICANHA_ID] }),
    ]);
    expect(crossed).toEqual([{ field: 'sections[1].itemIds', code: 'ITEM_DUPLICATED' }]);
    const same = stateOf([
      section('cat:Carnes', { itemIds: [PICANHA_ID, PICANHA_ID] }),
      section('cat:Hortifruti'),
    ]);
    expect(same).toEqual([{ field: 'sections[0].itemIds', code: 'ITEM_DUPLICATED' }]);
  });

  it.each([
    ['páginas que faltam', { pageCount: 2, pages: [exampleRequest().pages[0]] }, 'pages'],
    [
      'página repetida',
      { pageCount: 2, pages: [exampleRequest().pages[0], exampleRequest().pages[0]] },
      'pages',
    ],
    [
      'páginas a mais',
      { pageCount: 1, sections: [section('cat:Carnes'), section('cat:Bebidas')] },
      'pages',
    ],
    [
      'página fora de 1 a pageCount',
      {
        pageCount: 2,
        pages: [exampleRequest().pages[0], { ...exampleRequest().pages[1], page: 3 }],
      },
      'pages',
    ],
  ])('PAGES_MISMATCH: %s', (_name, over, field) => {
    expect(validateStructureState(exampleRequest(over))).toEqual([
      { field, code: 'PAGES_MISMATCH' },
    ]);
  });

  it('PAGES_MISMATCH: pinnedPage acima de pageCount, no campo da seção', () => {
    const issues = stateOf([
      section('cat:Hortifruti'),
      section('cat:Carnes'),
      section('cat:Bebidas', { pinnedPage: 3 }),
    ]);
    expect(issues).toEqual([{ field: 'sections[2].pinnedPage', code: 'PAGES_MISMATCH' }]);
  });

  it('as páginas na ordem que vierem, uma vez cada, são coerentes', () => {
    const [first, second] = exampleRequest().pages;
    expect(validateStructureState(exampleRequest({ pages: [second, first] }))).toEqual([]);
  });

  it('SECTION_UNKNOWN: categoria com acento ou "Sem categoria"; "Frios e Laticinios" sem acento é válida', () => {
    expect(stateOf([section('cat:Frios e Laticínios'), section('cat:Carnes')])).toEqual([
      { field: 'sections[0].id', code: 'SECTION_UNKNOWN' },
    ]);
    expect(stateOf([section('cat:Carnes'), section('cat:Sem categoria')])).toEqual([
      { field: 'sections[1].id', code: 'SECTION_UNKNOWN' },
    ]);
    expect(stateOf([section('cat:Frios e Laticinios'), section('cat:Carnes')])).toEqual([]);
  });

  it('SECTION_DUPLICATED: a repetição de Carnes, no campo `id` dela', () => {
    expect(stateOf([section('cat:Carnes'), section('cat:Bebidas'), section('cat:Carnes')])).toEqual(
      [{ field: 'sections[2].id', code: 'SECTION_DUPLICATED' }],
    );
  });

  it('vários problemas juntos saem de uma vez, na ordem dos códigos do contrato', () => {
    const issues = stateOf(
      [
        section('cat:Carnes', { itemIds: [PICANHA_ID], pinnedPage: 3 }),
        section('loose'),
        section('cat:Carnes', { itemIds: [PICANHA_ID] }),
        section('cat:Brinquedos'),
      ],
      { pageCount: 2 },
    );
    expect(issues).toEqual([
      { field: 'sections[0].pinnedPage', code: 'PAGES_MISMATCH' },
      { field: 'sections', code: 'LOOSE_NOT_LAST' },
      { field: 'sections[2].id', code: 'SECTION_DUPLICATED' },
      { field: 'sections[3].id', code: 'SECTION_UNKNOWN' },
      { field: 'sections[2].itemIds', code: 'ITEM_DUPLICATED' },
    ]);
  });

  it('o exemplo da spec: Carnes duas vezes e loose no meio dão SECTION_DUPLICATED e LOOSE_NOT_LAST', () => {
    const codes = stateOf([
      section('cat:Carnes'),
      section('loose'),
      section('cat:Carnes'),
      section('cat:Bebidas'),
    ]).map((issue) => issue.code);
    expect(codes).toEqual(['LOOSE_NOT_LAST', 'SECTION_DUPLICATED']);
  });
});

describe('assertStructureState', () => {
  it('retrato coerente passa; incoerente é 422 com `issues` fora de `details`', () => {
    expect(() => assertStructureState(exampleRequest())).not.toThrow();
    expect(() =>
      assertStructureState(exampleRequest({ sections: [section('cat:Carnes')] })),
    ).toThrow(
      expect.objectContaining({
        status: 422,
        response: {
          code: 'FLYER_PRO_STRUCTURE_STATE_INVALID',
          message: 'O retrato da Estrutura enviado está incoerente.',
          issues: [{ field: 'sections', code: 'TOO_FEW_SECTIONS' }],
        },
      }),
    );
  });
});
