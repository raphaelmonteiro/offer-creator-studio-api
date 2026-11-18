import { rawCategoryOf, searchNameOf, textOrNull } from './flyer-pro-enrich-input';

describe('normalização de ausente, null e branco (A-22)', () => {
  it.each([
    ['ausente', undefined],
    ['nulo', null],
    ['só com espaços', '   '],
    ['vazio', ''],
    ['não é texto', 42],
  ])('textOrNull: %s vale "sem ele"', (_, value) => {
    expect(textOrNull(value)).toBeNull();
  });

  it('textOrNull apara o texto', () => {
    expect(textOrNull('  MERCEARIA ')).toBe('MERCEARIA');
  });

  it.each([
    ['imported ausente', undefined],
    ['imported nulo', null],
    ['sem a chave rawCategory', {}],
    ['rawCategory nulo', { rawCategory: null }],
    ['rawCategory em branco', { rawCategory: '   ' }],
  ])('rawCategoryOf: %s vale "sem ele"', (_, imported) => {
    expect(rawCategoryOf(imported as Record<string, unknown> | null | undefined)).toBeNull();
  });

  it('rawCategoryOf devolve a categoria da planilha aparada', () => {
    expect(rawCategoryOf({ rawCategory: ' MERCEARIA ' })).toBe('MERCEARIA');
  });

  it.each([
    ['sourceName ausente', {}],
    ['sourceName nulo', { sourceName: null }],
    ['sourceName em branco', { sourceName: '  ' }],
  ])('searchNameOf: %s manda o name, nunca um nome vazio', (_, extra) => {
    expect(searchNameOf({ name: 'ABACATE', ...extra })).toBe('ABACATE');
  });

  it('searchNameOf prefere o nome da planilha', () => {
    expect(
      searchNameOf({ name: 'FILÉ DE TILÁPIA CONGELADO', sourceName: 'FILE DE TILAPIA CONJELADO' }),
    ).toBe('FILE DE TILAPIA CONJELADO');
  });
});
