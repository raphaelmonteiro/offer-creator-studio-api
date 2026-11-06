import { directorPlan } from '../testing/scene-director-fixtures';
import { DIRECTOR_JSON_SCHEMA, directorSchema } from './scene-director-schema';
import { checkPainted, enforcePaintedRefusal, promptableTexts } from './scene-director-painted';
import { classifyPainted, PaintedField, PaintedLevel } from './scene-painted-detector';

type Row = [text: string, level: PaintedLevel];

/** Tabela das duas direções da validação 4 (`design.md`): o que recusa, o que vira dúvida e o que segue. */
const PUT_TABLE: Row[] = [
  // a) recusa (rodada 1)
  ['escrever FELIZ PASCOA em letras grandes no topo; colocar o preco R$ 9,90', 'refuse'],
  ['uma placa escrita FELIZ PASCOA', 'refuse'],
  ['uma placa com a frase Feliz Pascoa', 'refuse'],
  ['faixa com os dizeres OFERTA', 'refuse'],
  ['selo 50% off', 'refuse'],
  ['o preço R$ 9,90 escrito na imagem', 'refuse'],
  ['preço R$ 12,50', 'refuse'],
  ['10 reais', 'refuse'],
  ['um selo de 20% de desconto', 'refuse'],
  ['o texto "PROMOÇÃO DE PÁSCOA" no topo', 'refuse'],
  ['uma frase entre aspas “Feliz Páscoa”', 'refuse'],
  ['escrever Ofertas da semana', 'refuse'],
  // a) recusa (rodada 2, R24)
  ['uma placa vazia para escrever FELIZ PASCOA', 'refuse'],
  ['um cartaz pronto para a frase OFERTA', 'refuse'],
  ['placa adequada para o preço R$ 9,90', 'refuse'],
  ['um campo com uma placa escrita FELIZ PASCOA para a festa', 'refuse'],
  ['escreve OFERTA sem erro', 'refuse'],
  ['escreve FELIZ PASCOA ao lado do logo', 'refuse'],
  ['tira o coelho para escrever FELIZ PASCOA', 'refuse'],
  ['troca o coelho por OFERTA', 'refuse'],
  ['troca o título por PROMOÇÃO', 'refuse'],
  ['tira para escrever FELIZ PASCOA', 'refuse'],
  ['tira para a OFERTA', 'refuse'],
  ['retira coloca OFERTA em cima', 'refuse'],
  ['um selo com a palavra Oi', 'refuse'],
  // b) dúvida
  ['titulo Ofertas da Semana', 'doubt'],
  ['a logo da loja sem fundo', 'doubt'],
  ['a logo da loja perto do título', 'doubt'],
  ['outro título', 'doubt'],
  ['um novo título', 'doubt'],
  ['um título', 'doubt'],
  ['flores no título', 'doubt'],
  ['lugar pro preço perto do título', 'doubt'],
  ['placa com letras', 'doubt'],
  ['uma placa de madeira com letras', 'doubt'],
  ['um coelho no estilo DISNEY', 'doubt'],
  ['adequada para inserir preços depois', 'doubt'],
  ['um selo com preço', 'doubt'],
  ['um letreiro luminoso', 'doubt'],
  ['o logotipo da loja no canto', 'doubt'],
  ['a logo no rodapé', 'doubt'],
  ['a marca do cliente', 'doubt'],
  ['a logo integrada ao fundo', 'doubt'],
  ['colocar o titulo', 'doubt'],
  // c) segue (palavra solta, rodada 2, R25)
  ['deixar a imagem 30% mais clara', 'none'],
  ['coelhos reais', 'none'],
  ['flores reais no campo', 'none'],
  ['flores logo abaixo do coelho', 'none'],
  ['colocar o sol logo acima da cesta', 'none'],
  ['aumentar 20% o coelho', 'none'],
  ['um coelho com marcas no pelo', 'none'],
  // c) segue (remoção, troca e reserva)
  ['tira o preço', 'none'],
  ['tira o preço R$ 9,90', 'none'],
  ['tira o ano abaixo do título', 'none'],
  ['tira o OFERTA', 'none'],
  ['apaga "Feliz Natal"', 'none'],
  ['sem R$ 9,90', 'none'],
  ['troca o OFERTA por flores', 'none'],
  ['trocar o preço pintado por flores', 'none'],
  ['lugar pros preços', 'none'],
  ['abrir espaço para os preços', 'none'],
  ['deixar o fundo atrás do título mais claro', 'none'],
  ['deixar sem texto legível', 'none'],
  ['uma área livre para o título', 'none'],
  ['uma TV na parede', 'none'],
];

const CHANGE_TABLE: Row[] = [
  ['escrever FELIZ PASCOA em letras grandes no topo; colocar o preco R$ 9,90', 'refuse'],
  ['coloca um selo OFERTA no canto', 'refuse'],
  ['adiciona "Feliz Páscoa" em cima', 'refuse'],
  ['pinta o texto PROMOÇÃO em cima', 'refuse'],
  ['troca o coelho por OFERTA', 'refuse'],
  ['tira o coelho para escrever FELIZ PASCOA', 'refuse'],
  ['deixa o "ovo azul" maior', 'doubt'],
  ['deixa o OVO AZUL maior', 'doubt'],
  ['colocar o titulo', 'doubt'],
  ['tira o preço', 'none'],
  ['tira o preço R$ 9,90', 'none'],
  ['apaga "Feliz Natal"', 'none'],
  ['trocar o preço pintado por flores', 'none'],
  ['abrir espaço para os preços', 'none'],
  ['deixar o fundo atrás do título mais claro', 'none'],
  ['deixar sem texto legível', 'none'],
  ['deixar a imagem 30% mais clara', 'none'],
  ['aumentar 20% o coelho', 'none'],
  ['mover as flores logo abaixo do coelho', 'none'],
];

/** Frases normais de cliente, fora das tabelas acima: nenhuma pode recusar nem virar dúvida. */
const NORMAL_PHRASES = [
  'deixa o céu mais azul e as nuvens maiores',
  'coloca um coelho de laço vermelho do lado esquerdo',
  'quero as cores mais quentes, tipo pôr do sol',
  'aumenta o coelho em 15% e centraliza',
  'troca a cesta por uma mais redonda',
  'tira as flores do canto direito',
  'diminui o brilho do sol, bem logo no começo do campo',
  'coloca ovos dourados perto da cesta',
  'faz o gramado mais verde, quase real',
  'pode deixar o fundo mais claro na parte de cima',
  'adiciona uma borboleta voando perto do coelho',
  'o coelho precisa ficar maior que a cesta',
  'quero mais flores amarelas perto da árvore rosa',
  'o coelho da frente tá cortado, dá pra mostrar ele inteiro?',
  'coloca um sol maior, uns 40% maior que o atual',
  'tira a cerca e põe uma árvore no lugar',
  'deixa tudo com cara de aquarela, bem suave',
  'muda a cesta para marrom claro e põe três ovos dentro',
  'aqui tá escuro, clareia essa parte do rio',
  'coloca uma nuvem logo atrás do sol',
  'quero o coelho olhando para a direita, bem real',
  'põe uma placa de madeira sem nada escrito',
  'remove a faixa branca de cima',
] as const;

/** Frases normais que citam texto, título, preço ou logo: por desenho (D-46, termo solto) viram dúvida, e não recusa. */
const DOUBT_PHRASES = [
  'faz o texto da cena ficar mais bonito',
  'o título do encarte vai ficar em cima, então deixa o céu limpo lá',
  'o preço vai entrar depois, deixa o rodapé livre',
  'a logo da loja vai ficar no canto, então não coloca nada ali',
] as const;

const FIELDS: Array<[PaintedField, Row[]]> = [
  ['put', PUT_TABLE],
  ['change', CHANGE_TABLE],
];

describe('detector de pintado: as duas direções (validação 4)', () => {
  describe.each(FIELDS)('campo %s', (field, table) => {
    it.each(table)('"%s" → %s', (text, level) => {
      expect(classifyPainted(text, field).level).toBe(level);
    });
  });

  it.each(NORMAL_PHRASES)('frase normal de cliente não recusa nem duvida: "%s"', (text) => {
    expect(classifyPainted(text, 'put').level).toBe('none');
    expect(classifyPainted(text, 'change').level).toBe('none');
  });

  it.each(DOUBT_PHRASES)('frase normal com termo solto vira dúvida, nunca recusa: "%s"', (text) => {
    expect(classifyPainted(text, 'change').level).toBe('doubt');
  });

  it('o preço vence o texto na recusa', () => {
    expect(classifyPainted('escrever OFERTA e o preço R$ 9,90', 'put').kind).toBe('painted_price');
    expect(classifyPainted('uma placa escrita FELIZ PASCOA', 'put').kind).toBe('painted_text');
  });

  it('a exceção nunca é por palavra solta: o objeto de remoção só cobre o que vem logo depois do verbo', () => {
    expect(classifyPainted('tira o coelho e coloca "OFERTA" em cima', 'change').level).toBe(
      'refuse',
    );
    expect(classifyPainted('sem fundo, escreve FELIZ PASCOA', 'put').level).toBe('refuse');
  });
});

describe('Escrita em what_to_change e dúvida na validação (checkPainted)', () => {
  const change = (what_to_change: string, extra = {}) =>
    directorPlan({ turn_kind: 'pedido_item', will_change_image: true, what_to_change, ...extra });

  it('a) em what_to_change vira recusa na hora, sem refazer', () => {
    const plan = change('escrever FELIZ PASCOA em letras grandes no topo; colocar o preco R$ 9,90');
    for (const final of [false, true]) {
      expect(checkPainted(plan, { final })).toMatchObject({
        kind: 'ok',
        plan: { turn_kind: 'recusa_pintado', refusal: 'painted_price', will_change_image: false },
      });
    }
  });

  it('b) refaz uma vez, com um motivo que não diz "não pinto", e persistindo pergunta', () => {
    const plan = change('colocar o titulo');
    const first = checkPainted(plan, { final: false });
    expect(first).toMatchObject({ kind: 'retry' });
    expect((first as { reason: string }).reason).not.toMatch(/n[ãa]o pinto/i);
    expect(checkPainted(plan, { final: true })).toEqual({ kind: 'question' });
  });

  it('c) segue sem refazer', () => {
    const plan = change('deixar a imagem 30% mais clara');
    expect(checkPainted(plan, { final: false })).toEqual({ kind: 'ok', plan });
  });

  it('inventory_keep perde o item em a) ou b), sem refazer, e o resto fica', () => {
    const plan = change('mais flores', {
      inventory_keep: ['titulo Feliz Pascoa', 'a logo da loja', 'preco R$ 9,90', 'coelho'],
    });
    expect(checkPainted(plan, { final: false })).toMatchObject({
      kind: 'ok',
      plan: { inventory_keep: ['coelho'] },
    });
  });

  it('o segundo plano, sem a dúvida, segue', () => {
    const plan = change('colocar mais flores no campo');
    expect(checkPainted(plan, { final: true })).toEqual({ kind: 'ok', plan });
  });
});

describe('recusa de pintado por regra (enforcePaintedRefusal)', () => {
  const item = (what_to_put: string, extra = {}) =>
    directorPlan({ turn_kind: 'pedido_item', will_change_image: true, what_to_put, ...extra });

  it('plano aceito pelo modelo com o preço em what_to_put vira recusa de preço', () => {
    expect(enforcePaintedRefusal(item('o preço R$ 9,90 escrito na imagem'))).toMatchObject({
      turn_kind: 'recusa_pintado',
      refusal: 'painted_price',
      will_change_image: false,
    });
  });

  it('a recusa do próprio Diretor continua recusa, e a imagem não muda', () => {
    const plan = enforcePaintedRefusal(
      directorPlan({
        turn_kind: 'recusa_pintado',
        refusal: 'painted_price',
        will_change_image: true,
      }),
    );
    expect(plan).toMatchObject({
      turn_kind: 'recusa_pintado',
      refusal: 'painted_price',
      will_change_image: false,
    });
  });

  it('recusa sem tipo (modelo esqueceu) fica como texto pintado', () => {
    expect(enforcePaintedRefusal(directorPlan({ turn_kind: 'recusa_pintado' })).refusal).toBe(
      'painted_text',
    );
  });

  it('refusal preenchido com outra classe força recusa_pintado', () => {
    expect(enforcePaintedRefusal({ ...item('um coelho'), refusal: 'painted_logo' })).toMatchObject({
      turn_kind: 'recusa_pintado',
      refusal: 'painted_logo',
    });
  });

  it.each(['camada', 'desfazer'] as const)('%s não é conferido', (turn_kind) => {
    const plan = directorPlan({
      turn_kind,
      what_to_put: 'texto "Ofertas"',
    });
    expect(enforcePaintedRefusal(plan)).toEqual(plan);
  });

  it('plano normal passa sem mudança', () => {
    const plan = item('mais flores no campo', { what_to_change: 'tirar o coelho da direita' });
    expect(enforcePaintedRefusal(plan)).toBe(plan);
  });

  describe('Diretor recusa a escrita (D-47: só `refusal` e `recusa_pintado` recusam)', () => {
    it('uma placa de boas-vindas, sem termo conhecido e com refusal painted_text, vira recusa', () => {
      const plan = item('uma placa de boas-vindas', { refusal: 'painted_text' });
      expect(enforcePaintedRefusal(plan)).toMatchObject({
        turn_kind: 'recusa_pintado',
        refusal: 'painted_text',
        will_change_image: false,
      });
    });

    it('Pedido disfarçado que escapa: sem refusal e sem forma conhecida, segue (limite aceito de D-46)', () => {
      const plan = item('uma placa de boas-vindas');
      expect(enforcePaintedRefusal(plan)).toBe(plan);
    });

    it('o campo written_content saiu do schema: saída com ele é inválida', () => {
      const raw = JSON.stringify({ ...directorPlan(), written_content: ['Feliz Páscoa'] });
      expect(directorSchema.safeParse(JSON.parse(raw)).success).toBe(false);
      expect(DIRECTOR_JSON_SCHEMA.schema.properties).not.toHaveProperty('written_content');
    });
  });
});

describe('promptableTexts: item que cairia em recusa ou dúvida sai do prompt', () => {
  it('sai o que escreve, o que tem preço ou logo e o que duvida; ficam "tirar o preço" e os normais', () => {
    expect(
      promptableTexts([
        'uma placa escrita FELIZ PASCOA',
        'selo 50% off',
        'a logo da loja',
        'titulo Ofertas',
        'indicação do ano 2027',
        'tirar o preço',
        'um rio',
        'tira esse 2027 do ovo',
        'deixar a imagem 30% mais clara',
      ]),
    ).toEqual([
      'tirar o preço',
      'um rio',
      'tira esse 2027 do ovo',
      'deixar a imagem 30% mais clara',
    ]);
  });
});
