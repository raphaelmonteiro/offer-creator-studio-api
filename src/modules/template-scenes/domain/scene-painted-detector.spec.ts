import { directorPlan } from '../testing/scene-director-fixtures';
import { checkPainted } from './scene-director-painted';
import { classifyPainted, PaintedField, PaintedLevel } from './scene-painted-detector';
import { onlyNumberLeft } from './scene-written-number';

type Row = [text: string, level: PaintedLevel];

/**
 * Rodada 3 (R29 a R31, D-49, D-50): os casos de `design.md`, nas duas direções. Cada defeito tem o caso que escapava
 * e o caso vizinho que não pode virar recusa nem pergunta de escrita (D-46, D-48).
 */
const PUT: Row[] = [
  // R29: preço com valor e sem cifrão, a vírgula entre dígitos não separa trecho
  ['um selo com 9,90', 'refuse'],
  ['um selo por 9,90', 'refuse'],
  ['oferta de 12,50 no canto', 'refuse'],
  ['um selo, 9,90 no canto', 'refuse'],
  ['oferta de 12,5 no canto', 'none'],
  ['um campo de 2,5 hectares', 'none'],
  // R30: a negação só cobre o objeto, nunca a escrita que vem depois
  ['placa sem moldura com OFERTA', 'refuse'],
  ['placa sem moldura escrita Feliz Pascoa', 'refuse'],
  ['um cartaz sem borda escrito Oferta da Semana', 'refuse'],
  ['selo sem borda 50% off', 'refuse'],
  ['placa sem moldura com R$ 9,90', 'refuse'],
  ['placa sem moldura', 'none'],
  ['um selo sem borda', 'none'],
  ['uma placa sem nada escrito', 'none'],
  ['uma placa sem texto escrito', 'none'],
  ['sem R$ 9,90', 'none'],
  ['um coelho sem laço', 'none'],
  // R31: "escritório" não é escrita
  ['um escritório ao fundo', 'none'],
  ['um escritório com mesa e cadeira', 'none'],
  ['uma placa escrita FELIZ PASCOA', 'refuse'],
  ['uma placa escritas Oi', 'refuse'],
  // D-50: caixa alta no plano continua recusada
  ['um COELHO grande', 'refuse'],
  ['um coelho GRANDE', 'refuse'],
  ['um coelho TV', 'none'],
  // D-49: termo seguido de nome
  ['o título Promoção de Páscoa', 'doubt'],
  ['o título', 'doubt'],
];

const CHANGE: Row[] = [
  // R31: o trecho sem verbo próprio herda a remoção; escrita tem verbo próprio
  ['Remover o selo e o preço R$ 9,90', 'none'],
  ['Remover o coelho e o título', 'none'],
  ['tira a logo e o preço', 'none'],
  ['tira OFERTA e PROMOCAO', 'none'],
  ['Remover o coelho, o selo e o título', 'none'],
  ['tira o título e o preço', 'none'],
  ['tira o coelho e escreve OFERTA', 'refuse'],
  ['tira o coelho e coloca OFERTA em cima', 'refuse'],
  ['tira o coelho e pinta "Oi"', 'refuse'],
  ['tira o coelho e coloca flores', 'none'],
  ['coloca um selo e o preço R$ 9,90', 'refuse'],
  ['tira o coelho. Escreve OFERTA', 'refuse'],
  // R31: "o que está escrito" é objeto de remoção
  ['Remover o que está escrito no ovo', 'none'],
  ['tira o que estiver escrito', 'none'],
  ['Remover o texto escrito', 'none'],
  ['Remover o coelho e escrever OFERTA', 'refuse'],
  ['tira o que está escrito e escreve OFERTA', 'refuse'],
];

describe.each([
  ['put', PUT],
  ['change', CHANGE],
] as Array<[PaintedField, Row[]]>)('detector, rodada 3, campo %s', (field, table) => {
  it.each(table)('"%s" → %s', (text, level) => {
    expect(classifyPainted(text, field).level).toBe(level);
  });
});

describe('detector, rodada 3: o termo que sai e o nome depois dele (D-49)', () => {
  const plan = (what_to_change: string, what_to_put: string) =>
    directorPlan({
      turn_kind: 'pedido_item',
      will_change_image: true,
      what_to_change,
      what_to_put,
    });

  it.each([
    ['Remover o título atual', 'o título'],
    ['Remover o título', 'Flores no lugar do título'],
    ['Remover o título', 'Flores onde estava o título'],
    ['Remover o título', 'Flores cobrindo o título de cima'],
    ['Remover o título antigo', 'Flores cobrindo o título antigo'],
    ['Remover o coelho e o título', 'Flores cobrindo o título'],
    ['troca o título por flores', 'flores cobrindo o título'],
  ])('"%s" + "%s": o termo é referência ao que sai, segue', (change, put) => {
    const p = plan(change, put);
    expect(checkPainted(p, { final: false })).toEqual({ kind: 'ok', plan: p });
  });

  it.each([
    ['Remover o título atual', 'o título Promoção de Páscoa'],
    ['Remover o título', 'Flores cobrindo o título Feliz Páscoa'],
    ['Remover o título', 'um título'],
    ['Remover o título', 'outro título'],
  ])('"%s" + "%s": nome depois do termo, refaz e, persistindo, pergunta', (change, put) => {
    const p = plan(change, put);
    expect(checkPainted(p, { final: false })).toMatchObject({ kind: 'retry' });
    expect(checkPainted(p, { final: true })).toEqual({ kind: 'question' });
  });

  it('o que o plano manda tirar com vários objetos libera o termo no what_to_put', () => {
    const p = plan('Remover o selo e o título', 'Flores cobrindo o título');
    expect(checkPainted(p, { final: false })).toEqual({ kind: 'ok', plan: p });
  });
});

describe('número solto (R34, validação 7)', () => {
  it.each(['99 no canto', '2027 em cima', 'o número 99 no canto', '7', '12 de abril no topo'])(
    '"%s": só sobra o número, o cliente pediu o número',
    (text) => expect(onlyNumberLeft(text)).toBe(true),
  );

  it.each([
    '3 coelhos',
    '12 ovos na cesta',
    'um coelho com 3 anos',
    'ovos e 2027 em cima',
    'sol grande',
  ])('"%s": sobra palavra, segue', (text) => expect(onlyNumberLeft(text)).toBe(false));
});

type Neighbors = Array<[field: PaintedField, text: string, level: PaintedLevel]>;

/** Rodada 4 (R38 a R44): cada recusa falsa corrigida e o vizinho que continua recusado (D-48). */
const ROUND4: Neighbors = [
  // R38: o particípio na remoção não vira pedido de escrita
  ['change', 'Remover o título escrito na parte superior', 'none'],
  ['change', 'Remover o título escrito na parte superior central', 'none'],
  ['change', 'Remover o texto que está escrito no ovo', 'none'],
  ['change', 'tira tudo o que está escrito', 'none'],
  ['change', 'tira o título que está escrito', 'none'],
  ['change', 'tira as letras que estão escritas no ovo', 'none'],
  ['change', 'Remover o 2027 que está escrito no ovo', 'none'],
  ['change', 'tira o que tem escrito no ovo', 'none'],
  ['change', 'apaga o que aparece escrito', 'none'],
  ['change', 'tira o coelho para escrever FELIZ PASCOA', 'refuse'],
  ['change', 'tira o coelho depois escreve OFERTA', 'refuse'],
  ['put', 'uma placa escrita FELIZ PASCOA', 'refuse'],
  // R39: o que vem depois de "com" faz parte do objeto removido
  ['change', 'tira a placa com a frase Feliz Natal', 'none'],
  ['change', 'remove a placa com o texto', 'none'],
  ['change', 'Remover o selo com 20% de desconto', 'none'],
  ['change', 'Remover o selo com o preço R$ 9,90', 'none'],
  ['change', 'tira o coelho e coloca um selo com R$ 9,90', 'refuse'],
  ['put', 'um selo com R$ 9,90', 'refuse'],
  // R40: o objeto de "sem" pode ter nome
  ['put', 'o selo sem o preço R$ 9,90', 'none'],
  ['put', 'o ovo sem a palavra OFERTA', 'none'],
  ['put', 'a placa sem a frase "Feliz Natal"', 'none'],
  ['put', 'o cartaz sem o texto OFERTA', 'none'],
  ['put', 'o ovo sem a palavra OFERTA com R$ 9,90', 'refuse'],
  ['put', 'placa sem moldura com OFERTA', 'refuse'],
  // R41: medida não é preço
  ['put', 'uma árvore de 2,50 metros', 'none'],
  ['put', 'aumentar a árvore 1,50 vezes', 'none'],
  ['put', 'coelho 1,25 vezes maior', 'none'],
  ['put', 'um ovo de 1,50 m', 'none'],
  ['put', 'um coelho de 1,20 cm de altura', 'none'],
  ['put', 'aumentar 1,50% o coelho', 'none'],
  ['put', 'um coelho com 1,20 de altura', 'none'],
  ['put', 'um painel de 1,20 x 2,00 metros', 'none'],
  ['put', 'subir o sol 1,50 acima', 'none'],
  ['put', 'oferta de 12,50 no canto', 'refuse'],
  ['put', 'um selo com 9,90', 'refuse'],
  ['put', 'um ovo de 1,50 reais', 'refuse'],
  // R44: o outro verbo depois da remoção não herda a remoção
  ['change', 'Remover o coelho e acrescentar R$ 9,90', 'refuse'],
  ['change', 'Remover o coelho e acrescentar 50% off', 'refuse'],
  ['change', 'Remover o coelho e inserir OFERTA', 'refuse'],
  ['change', 'Remover o coelho e desenhar FELIZ PASCOA', 'refuse'],
  ['change', 'Remover o coelho e aplicar o texto "Oi"', 'refuse'],
  ['change', 'tira o coelho e escreve OFERTA', 'refuse'],
  ['change', 'tira o coelho e coloca OFERTA', 'refuse'],
  ['change', 'tira o coelho e pinta R$ 9,90', 'refuse'],
  ['change', 'Remover o coelho e acrescentar flores', 'none'],
  ['change', 'Remover o coelho e criar uma árvore', 'none'],
  ['change', 'Remover o coelho e mostrar a cesta', 'none'],
  ['change', 'Remover o coelho e a criança', 'none'],
  ['change', 'Remover o selo e o preço R$ 9,90', 'none'],
  ['change', 'Remover o coelho e o que está escrito', 'none'],
];

describe('detector, rodada 4 (R38 a R44): recusa falsa corrigida e vizinhos', () => {
  it.each(ROUND4)('%s: "%s" → %s', (field, text, level) => {
    expect(classifyPainted(text, field).level).toBe(level);
  });
});

describe('nome depois do termo (D-49, R43): inicial maiúscula ou aspas, sem lista de palavras', () => {
  const plan = (what_to_change: string, what_to_put: string) =>
    directorPlan({
      turn_kind: 'pedido_item',
      will_change_image: true,
      what_to_change,
      what_to_put,
    });

  it.each([
    'flores sobre o título decorativo',
    'flores cobrindo o título na parte superior',
    'flores sobre o título no topo',
    'flores sobre o título pintado',
    'flores sobre o título em aquarela',
    'flores sobre o título grande',
    'flores sobre o título de Páscoa',
    'flores no espaço do título decorativo',
    // escape aceito por D-48 (DT-16): sem maiúscula nem aspas não dá para saber que é nome
    'o título promoção de páscoa',
    'o título: Promoção',
  ])('"%s" com o título removido: segue', (put) => {
    const p = plan('Remover o título da parte superior', put);
    expect(checkPainted(p, { final: false })).toEqual({ kind: 'ok', plan: p });
  });

  it.each(['o título Promoção de Páscoa', 'flores com o título Feliz Páscoa', 'o título Oferta'])(
    '"%s" com o título removido: pergunta fixa',
    (put) => {
      const p = plan('Remover o título da parte superior', put);
      expect(checkPainted(p, { final: true })).toEqual({ kind: 'question' });
    },
  );

  it.each(['o título "Oferta"', 'o título OFERTA'])(
    '"%s": recusa, antes de chegar ao termo',
    (put) => {
      const p = plan('Remover o título da parte superior', put);
      expect(checkPainted(p, { final: false })).toMatchObject({
        kind: 'ok',
        plan: { turn_kind: 'recusa_pintado' },
      });
    },
  );

  it('vale para todo termo solto: "a logo Coca-Cola" pergunta, "a logo decorativa" segue', () => {
    const named = plan('Remover a logo', 'a logo Coca-Cola');
    expect(checkPainted(named, { final: true })).toEqual({ kind: 'question' });
    const cited = plan('Remover a logo', 'flores sobre a logo decorativa');
    expect(checkPainted(cited, { final: false })).toEqual({ kind: 'ok', plan: cited });
  });

  it.each(['o título decorativo', 'um título', 'outro título'])(
    '"%s" sem o título removido: dúvida, como antes',
    (put) => {
      const p = plan('tirar o coelho', put);
      expect(checkPainted(p, { final: true })).toEqual({ kind: 'question' });
    },
  );
});
