import { hasWrittenNumber, onlyNumberLeft, stripNumberClauses } from './scene-written-number';

describe('Detector de ano, data e número escrito (D-42)', () => {
  it.each([
    ['indicação do ano 2027', true],
    ['ovos de Páscoa para 2027', true],
    ['o ano de 1999', true],
    ['ovos e a data 12/04', true],
    ['entrega em 12 de abril', true],
    ['com o número 7 no ovo', true],
    ['indicação da data', true],
    ['3 coelhos', false],
    ['três coelhos com tema de ano novo', false],
    ['ano novo', false],
    ['100 flores no campo', false],
    ['coelho com cesta', false],
    ['', false],
  ])('"%s" → %s', (text, expected) => {
    expect(hasWrittenNumber(text)).toBe(expected);
  });

  it('a cláusula que pede para tirar o número não conta quando a remoção vale', () => {
    expect(hasWrittenNumber('tira o 2027 do ovo', { removal: true })).toBe(false);
    expect(hasWrittenNumber('tira o 2027 do ovo')).toBe(true);
    expect(hasWrittenNumber('remover o número 7', { removal: true })).toBe(false);
  });

  it('a remoção isenta só a própria cláusula', () => {
    expect(hasWrittenNumber('tira o coelho e coloca 2027', { removal: true })).toBe(true);
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
      ['ovos e coelho', 'ovos e coelho'],
      ['indicação do ano 2027', ''],
    ])('"%s"', (text, expected) => {
      expect(stripNumberClauses(text)).toBe(expected);
    });
  });

  describe('onlyNumberLeft: o cliente pediu o número', () => {
    it.each([
      ['2027 em cima', true],
      ['o ano 2027', true],
      ['12 de abril no topo', true],
      ['ovos e 2027 em cima', false],
      ['ovos de Páscoa com 2027', false],
      ['3 coelhos', false],
    ])('"%s" → %s', (text, expected) => {
      expect(onlyNumberLeft(text)).toBe(expected);
    });
  });
});

describe('deslocamento não é número escrito (R42)', () => {
  it.each([
    '20% para a direita',
    '30% acima',
    '10 para cima',
    '1,50 acima',
    '1 à esquerda e 1 à direita',
    '99 à direita',
    '5 pra baixo',
  ])('"%s": move algo, segue', (text) => expect(onlyNumberLeft(text)).toBe(false));

  it.each(['99 no canto', '3 no canto', '2027 acima', '12 de abril para cima', '99 em cima'])(
    '"%s": o cliente pediu o número, recusa',
    (text) => expect(onlyNumberLeft(text)).toBe(true),
  );
});
