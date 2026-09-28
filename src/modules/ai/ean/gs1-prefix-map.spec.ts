import { brandsCompatible, Gs1PrefixMap, prefixOf } from './gs1-prefix-map';

describe('Gs1PrefixMap', () => {
  const mapa = new Gs1PrefixMap();
  // Heinz Brasil: 7896102...
  for (const g of ['7896102503722', '7896102500011', '7896102500028']) mapa.add(g, 'Heinz');
  // Prefixo com só um exemplo — evidência fraca.
  mapa.add('7898765000017', 'Marca Pequena');

  it('veta marca estranha num prefixo conhecido', () => {
    expect(mapa.veto('7896102509999', 'Quero')).toMatch(/7896102.*heinz/);
  });

  it('não veta a marca dona do prefixo, com grafia diferente', () => {
    expect(mapa.veto('7896102509999', 'HEINZ')).toBeNull();
  });

  it('prefixo desconhecido não veta', () => {
    expect(mapa.veto('7891234000000', 'Quero')).toBeNull();
  });

  it('prefixo com pouca evidência não veta', () => {
    expect(mapa.veto('7898765000024', 'Outra')).toBeNull();
  });

  it('imagem sem marca não é vetada', () => {
    expect(mapa.veto('7896102509999', null)).toBeNull();
  });
});

describe('prefixOf', () => {
  it('aceita GTIN-14 com zero à esquerda', () => {
    expect(prefixOf('07898949912088')).toBe('7898949');
  });
  it('ignora código interno de peso variável', () => {
    expect(prefixOf('2012345000007')).toBeNull();
    expect(prefixOf('0259780043725')).toBeNull();
  });
});

describe('brandsCompatible', () => {
  it.each([
    ['sadia', 'sadia s a', true],
    ['matte leao', 'leao', true],
    ['seara', 'sadia', false],
  ])('%s ~ %s = %s', (a, b, esperado) => {
    expect(brandsCompatible(a as string, b as string)).toBe(esperado);
  });
});
