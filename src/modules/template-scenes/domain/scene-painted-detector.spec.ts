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
