import { hasWrittenNumber, stripNumberClauses } from './scene-written-number';

describe('Ano e data de contexto não vão ao modelo de imagem (detector, D-42)', () => {
  it.each([
    ['indicação do ano 2027', true],
    ['ovos de Páscoa para 2027', true],
    ['o ano de 1999', true],
    ['ovos e a data 12/04', true],
    ['entrega em 12 de abril', true],
    ['with the number 7 on the egg', true],
    ['with the year 2027', true],
    ['indicação da data', true],
    ['Easter eggs, with the date April 12', true],
    ['sale ends 12th of April', true],
    ['sale ends on April 12th', true],
    ['3 coelhos', false],
    ['three bunnies with a new year theme', false],
    ['ano novo', false],
    ['100 flores no campo', false],
    ['coelho com cesta', false],
    ['reduce the opacity to 0.75, 20% to the right', false],
    ['', false],
  ])('"%s" → %s', (text, expected) => {
    expect(hasWrittenNumber(text)).toBe(expected);
  });

  describe('Fração não é data (R54)', () => {
    it.each([
      'ocupar 1/3 da imagem',
      'ocupar 2/3 da imagem',
      'reduzir o coelho a 1/2',
      'o coelho em 1/4 da altura',
      'deixar o céu com 1/3 da imagem',
      'make the bunny take 1/3 of the image',
      'shrink it to 1/2',
    ])('"%s" segue, sem refazer', (text) => {
      expect(hasWrittenNumber(text, { removal: true })).toBe(false);
    });

    it('12/04 e 12 de abril seguem contando', () => {
      expect(hasWrittenNumber('data 12/04')).toBe(true);
      expect(hasWrittenNumber('data 12 de abril')).toBe(true);
    });
  });

  describe('Troca do número (R54)', () => {
    it.each([
      'troca o 2027 por flores',
      'trocar 12/04 por flores',
      'substitui o 2027 por um sol',
      'Replace the 2027 with flowers',
      'swap the 2027 by a sun',
    ])('"%s": o número antes de "por" é objeto de remoção', (text) => {
      expect(hasWrittenNumber(text, { removal: true })).toBe(false);
    });

    it('o número depois de "por" é escrita e conta', () => {
      expect(hasWrittenNumber('troca as flores por 2027', { removal: true })).toBe(true);
      expect(hasWrittenNumber('replace the flowers with 2027', { removal: true })).toBe(true);
    });
  });

  describe('Remoção do número herdada (R55)', () => {
    it.each([
      'tira o selo e o 2027',
      'Remover o coelho e o 2027 pintado',
      'Remove the seal and the 2027',
      'take out the bunny and the 2027 badge',
    ])('"%s": o trecho herdado depois de " e " é remoção', (text) => {
      expect(hasWrittenNumber(text, { removal: true })).toBe(false);
      expect(stripNumberClauses(text, { removal: true })).toBe(text);
    });

    it('sem verbo de remoção antes, o " e " não herda nada', () => {
      expect(hasWrittenNumber('coloca ovos e o 2027', { removal: true })).toBe(true);
    });
  });

  it('a cláusula que pede para tirar o número não conta quando a remoção vale', () => {
    expect(hasWrittenNumber('tira o 2027 do ovo', { removal: true })).toBe(false);
    expect(hasWrittenNumber('tira o 2027 do ovo')).toBe(true);
    expect(hasWrittenNumber('remover o número 7', { removal: true })).toBe(false);
  });

  it('a remoção isenta só a própria cláusula', () => {
    expect(hasWrittenNumber('tira o coelho e coloca 2027', { removal: true })).toBe(true);
    expect(hasWrittenNumber('tira o coelho, coloca 2027', { removal: true })).toBe(true);
  });

  describe('stripNumberClauses: corta só o trecho do número', () => {
    it.each([
      [
        'Ovos de Páscoa e um coelho em um cenário bonito, com referências visuais à Páscoa e indicação do ano 2027',
        'Ovos de Páscoa e um coelho em um cenário bonito, com referências visuais à Páscoa',
      ],
      ['ovos e a data 12/04', 'ovos'],
      ['indicação do ano 2027, ovos e um coelho', 'ovos e um coelho'],
      ['ovos; 2027 em cima; coelho', 'ovos; coelho'],
      ['Easter eggs and a bunny and the year 2027', 'Easter eggs and a bunny'],
      ['ovos e coelho', 'ovos e coelho'],
      ['indicação do ano 2027', ''],
    ])('"%s"', (text, expected) => {
      expect(stripNumberClauses(text)).toBe(expected);
    });
  });
});
