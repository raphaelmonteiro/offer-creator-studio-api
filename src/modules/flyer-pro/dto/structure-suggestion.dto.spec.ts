import { randomUUID } from 'crypto';
import { CERVEJA_ID, exampleRequest, PICANHA_ID } from '../domain/structure-suggestion.testutil';
import { nestedErrorsOf } from './dto-paths.testutil';
import { StructureSuggestionDto } from './structure-suggestion.dto';

const errorsOf = (body: object) =>
  nestedErrorsOf(StructureSuggestionDto, body as Record<string, unknown>);

/** O retrato de exemplo com a seção `index` trocada ou acrescida de campos. */
const withSection = (index: number, over: Record<string, unknown>) => {
  const request = exampleRequest();
  request.sections[index] = { ...request.sections[index], ...over };
  return request;
};

describe('StructureSuggestionDto: a forma do pedido da sugestão (N19)', () => {
  it('aceita o retrato de exemplo, sem unplaced, e com unplaced, quota, pinnedPage e destaques', async () => {
    expect(await errorsOf(exampleRequest())).toEqual([]);
    const full = withSection(2, { quota: 4, pinnedPage: 2 });
    expect(
      await errorsOf({
        ...full,
        unplaced: 3,
        heroes: [
          { itemId: PICANHA_ID, size: '2x1' },
          { itemId: CERVEJA_ID, size: '2x2' },
        ],
      }),
    ).toEqual([]);
  });

  it('campo desconhecido é recusado (o pipe global usa forbidNonWhitelisted)', async () => {
    expect(await errorsOf({ ...exampleRequest(), names: ['PICANHA'] })).toEqual(['names']);
    expect(await errorsOf(withSection(0, { title: 'Hortifruti' }))).toEqual(['sections.0.title']);
  });

  it('null em campo opcional é 400: unplaced, pinnedPage e quota', async () => {
    expect(await errorsOf({ ...exampleRequest(), unplaced: null })).toEqual(['unplaced']);
    expect(await errorsOf(withSection(2, { pinnedPage: null }))).toEqual(['sections.2.pinnedPage']);
    expect(await errorsOf(withSection(1, { quota: null }))).toEqual(['sections.1.quota']);
  });

  it('opcional ausente passa, e opcional fora do intervalo é recusado', async () => {
    expect(await errorsOf(withSection(2, { pinnedPage: 0 }))).toEqual(['sections.2.pinnedPage']);
    expect(await errorsOf(withSection(2, { pinnedPage: 5 }))).toEqual(['sections.2.pinnedPage']);
    expect(await errorsOf(withSection(2, { quota: 501 }))).toEqual(['sections.2.quota']);
    expect(await errorsOf({ ...exampleRequest(), unplaced: 501 })).toEqual(['unplaced']);
    expect(await errorsOf({ ...exampleRequest(), unplaced: -1 })).toEqual(['unplaced']);
  });

  it.each([
    ['level 4', { level: 4 }, 'level'],
    ['level 0', { level: 0 }, 'level'],
    ['pageCount 5', { pageCount: 5 }, 'pageCount'],
    ['pageCount 0', { pageCount: 0 }, 'pageCount'],
    ['stateDigest vazio', { stateDigest: '' }, 'stateDigest'],
    ['stateDigest com 65 caracteres', { stateDigest: 'a'.repeat(65) }, 'stateDigest'],
    ['pages vazio', { pages: [] }, 'pages'],
    ['5 páginas', { pages: [1, 2, 3, 4, 1].map((page) => examplePage(page)) }, 'pages'],
    ['sections vazio', { sections: [] }, 'sections'],
    ['heroes ausente', { heroes: undefined }, 'heroes'],
    ['heroes que não é lista', { heroes: 'PICANHA' }, 'heroes'],
  ])('recusa %s', async (_name, over, path) => {
    expect(await errorsOf({ ...exampleRequest(), ...over })).toEqual([path]);
  });

  it('recusa 17 seções e aceita 16', async () => {
    const section = (index: number) => ({
      id: `cat:Cat ${index}`,
      itemIds: [],
      cells: 0,
      pages: [],
    });
    const sections = (count: number) => Array.from({ length: count }, (_, index) => section(index));
    expect(await errorsOf({ ...exampleRequest(), sections: sections(16) })).toEqual([]);
    expect(await errorsOf({ ...exampleRequest(), sections: sections(17) })).toEqual(['sections']);
  });

  it('recusa id de seção sem o prefixo, com categoria vazia ou com mais de 40 caracteres', async () => {
    for (const id of ['Hortifruti', 'cat:', `cat:${'a'.repeat(41)}`, 'loose2', '']) {
      expect(await errorsOf(withSection(0, { id }))).toEqual(['sections.0.id']);
    }
    for (const id of ['loose', `cat:${'a'.repeat(40)}`, 'cat:Frios e Laticinios']) {
      expect(await errorsOf(withSection(0, { id }))).toEqual([]);
    }
  });

  it('recusa item que não é UUID, mais de 500 ids numa seção e itemIds que não é lista', async () => {
    expect(await errorsOf(withSection(0, { itemIds: ['abc'] }))).toEqual(['sections.0.itemIds']);
    const many = Array.from({ length: 501 }, () => randomUUID());
    expect(await errorsOf(withSection(0, { itemIds: many }))).toEqual(['sections.0.itemIds']);
    expect(await errorsOf(withSection(0, { itemIds: PICANHA_ID }))).toEqual(['sections.0.itemIds']);
  });

  it('recusa cells fora de 0 a 4000 e pages com página fora de 1 a 4 ou mais de 4 entradas', async () => {
    expect(await errorsOf(withSection(0, { cells: -1 }))).toEqual(['sections.0.cells']);
    expect(await errorsOf(withSection(0, { cells: 4001 }))).toEqual(['sections.0.cells']);
    expect(await errorsOf(withSection(0, { pages: [0] }))).toEqual(['sections.0.pages']);
    expect(await errorsOf(withSection(0, { pages: [5] }))).toEqual(['sections.0.pages']);
    expect(await errorsOf(withSection(0, { pages: [1, 2, 3, 4, 1] }))).toEqual([
      'sections.0.pages',
    ]);
    expect(await errorsOf(withSection(0, { pages: [] }))).toEqual([]);
  });

  it('recusa página com campo fora da forma', async () => {
    const page = (over: Record<string, unknown>) => ({ ...examplePage(1), ...over });
    const body = (over: Record<string, unknown>) => ({
      ...exampleRequest(),
      pages: [page(over), examplePage(2)],
    });
    expect(await errorsOf(body({ page: 5 }))).toEqual(['pages.0.page']);
    expect(await errorsOf(body({ capacityCells: 4001 }))).toEqual(['pages.0.capacityCells']);
    expect(await errorsOf(body({ usedCells: -1 }))).toEqual(['pages.0.usedCells']);
    expect(await errorsOf(body({ header: 'sim' }))).toEqual(['pages.0.header']);
    expect(await errorsOf(body({ footer: undefined }))).toEqual(['pages.0.footer']);
  });

  it('recusa destaque com tamanho 3x3, sem itemId UUID ou que não é objeto', async () => {
    const heroes = (value: unknown[]) => ({ ...exampleRequest(), heroes: value });
    expect(await errorsOf(heroes([{ itemId: PICANHA_ID, size: '3x3' }]))).toEqual([
      'heroes.0.size',
    ]);
    expect(await errorsOf(heroes([{ itemId: 'picanha', size: '2x1' }]))).toEqual([
      'heroes.0.itemId',
    ]);
    expect((await errorsOf(heroes([null]))).length).toBeGreaterThan(0);
  });
});

function examplePage(page: number) {
  return { page, capacityCells: 8, usedCells: 2, header: false, footer: false };
}
