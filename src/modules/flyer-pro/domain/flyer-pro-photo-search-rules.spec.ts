import {
  hasMorePages,
  isHttpImageUrl,
  isSmallPhoto,
  keepNewResults,
} from './flyer-pro-photo-search-rules';

describe('isSmallPhoto: o menor lado abaixo de 300 px (D-5)', () => {
  it.each([
    [240, 240, true],
    [299, 1000, true],
    [1000, 299, true],
    [300, 300, false],
    [300, 240, true],
    [1000, 1000, false],
  ])('%i x %i: small %s', (width, height, small) => {
    expect(isSmallPhoto(width, height)).toBe(small);
  });

  it('tamanho desconhecido nunca é pequeno', () => {
    expect(isSmallPhoto(null, null)).toBe(false);
  });
});

describe('isHttpImageUrl', () => {
  it.each([
    ['https://www.extrabom.com.br/img/x.jpg', true],
    ['http://exemplo.com/x.jpg', true],
    ['data:image/png;base64,AAAA', false],
    ['ftp://exemplo.com/x.jpg', false],
    ['//exemplo.com/x.jpg', false],
    ['foto.jpg', false],
    ['', false],
  ])('%j: %s', (url, expected) => {
    expect(isHttpImageUrl(url)).toBe(expected);
  });
});

describe('keepNewResults: o que a página tem de aproveitável', () => {
  const of = (...urls: string[]) => urls.map((imageUrl) => ({ imageUrl }));

  it('tira o que não é http(s) e o que repete página anterior, na ordem da Serper', () => {
    const results = of('https://a/1.jpg', 'data:x', 'https://a/2.jpg', '', 'https://a/3.jpg');

    expect(keepNewResults(results, new Set(['https://a/2.jpg']))).toEqual(
      of('https://a/1.jpg', 'https://a/3.jpg'),
    );
  });

  it('sem páginas anteriores nada repete', () => {
    expect(keepNewResults(of('https://a/1.jpg'), new Set())).toEqual(of('https://a/1.jpg'));
  });
});

describe('hasMorePages', () => {
  it.each([
    [1, 10, true],
    [9, 1, true],
    [2, 0, false],
    [10, 10, false],
    [10, 0, false],
  ])('página %i com %i novos: hasMore %s', (page, fresh, expected) => {
    expect(hasMorePages(page, fresh)).toBe(expected);
  });
});
