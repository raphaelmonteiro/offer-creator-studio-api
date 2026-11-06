import { directorPlan } from '../testing/scene-director-fixtures';
import {
  checkPainted,
  enforcePaintedRefusal,
  paintedKindOf,
  promptableTexts,
} from './scene-director-painted';

const item = (what_to_put: string, what_to_change = '') =>
  directorPlan({ turn_kind: 'pedido_item', will_change_image: true, what_to_put, what_to_change });

describe('recusa de pintado por regra', () => {
  describe('Ordem para ignorar as regras', () => {
    it('plano aceito pelo modelo com o preço em what_to_put vira recusa de preço', () => {
      const plan = enforcePaintedRefusal(item('o preço R$ 9,90 escrito na imagem'));
      expect(plan).toMatchObject({
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
      const plan = enforcePaintedRefusal(directorPlan({ turn_kind: 'recusa_pintado' }));
      expect(plan.refusal).toBe('painted_text');
    });

    it('refusal preenchido com outra classe força recusa_pintado', () => {
      const plan = enforcePaintedRefusal({ ...item('um coelho'), refusal: 'painted_logo' });
      expect(plan).toMatchObject({ turn_kind: 'recusa_pintado', refusal: 'painted_logo' });
    });
  });

  describe('Modelo erra e o código barra', () => {
    it.each([
      ['escreva o preço R$ 9,90', 'painted_price'],
      ['R$ 12,50', 'painted_price'],
      ['10 reais', 'painted_price'],
      ['um selo com preço', 'painted_price'],
      ['o texto "PROMOÇÃO DE PÁSCOA" no topo', 'painted_text'],
      ['uma frase entre aspas “Feliz Páscoa”', 'painted_text'],
      ['escrever Ofertas da semana', 'painted_text'],
      ['um letreiro luminoso', 'painted_text'],
      ['o logotipo da loja no canto', 'painted_logo'],
      ['a logo no rodapé', 'painted_logo'],
      ['a marca do cliente', 'painted_logo'],
    ])('what_to_put "%s" é %s', (what, kind) => {
      expect(paintedKindOf(what)).toBe(kind);
      expect(enforcePaintedRefusal(item(what)).refusal).toBe(kind);
    });
  });

  describe('Tirar o que foi pintado', () => {
    it('"tira esse preço" segue como pedido de item: o preço está em what_to_change', () => {
      const plan = item('', 'remover o preço pintado no canto');
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });

    it('trocar o que está na imagem sem pedir conteúdo pintado também segue', () => {
      const plan = item('um prado verde', 'tirar o texto da placa');
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });
  });

  describe('Placa com letras', () => {
    it('"letras" é termo da validação 4 (design.md): a placa com letras vira recusa, sem prompt', () => {
      const plan = item('uma placa de madeira com letras');
      expect(paintedKindOf(plan.what_to_put)).toBe('painted_text');
      expect(enforcePaintedRefusal(plan)).toMatchObject({ turn_kind: 'recusa_pintado' });
    });

    it('"sem letras" e "sem texto legível" não pedem escrita', () => {
      expect(paintedKindOf('deixar sem texto legível, sem letras')).toBeNull();
    });
  });

  describe('Integrar a logo', () => {
    it('"integra a logo na imagem" vira recusa de logo', () => {
      const plan = enforcePaintedRefusal(item('a logo integrada ao fundo'));
      expect(plan).toMatchObject({ turn_kind: 'recusa_pintado', refusal: 'painted_logo' });
    });
  });

  describe('Turnos que não pintam', () => {
    it.each(['camada', 'desfazer'] as const)('%s não é conferido', (turn_kind) => {
      const plan = directorPlan({ turn_kind, what_to_put: 'texto "Ofertas"' });
      expect(enforcePaintedRefusal(plan)).toEqual(plan);
    });

    it('plano normal passa sem mudança', () => {
      const plan = item('mais flores no campo', 'tirar o coelho da direita');
      expect(enforcePaintedRefusal(plan)).toBe(plan);
    });
  });
});

describe('Item em aberto com conteúdo pintado (C-2)', () => {
  it('o item que fala em texto, preço ou logo sai das saídas ao modelo, e o resto fica', () => {
    expect(
      promptableTexts([
        'um rio no meio',
        'escreve FELIZ PASCOA',
        'o preço R$ 9,90 no canto',
        'a logo no rodapé',
        'coloca um coelho',
      ]),
    ).toEqual(['um rio no meio', 'coloca um coelho']);
    expect(promptableTexts([])).toEqual([]);
  });
});

describe('Pedido com ano não fica em aberto (D-42)', () => {
  it('o item com ano, data ou número escrito sai do prompt, e "tira o 2027", "3 coelhos" e "ano novo" ficam', () => {
    expect(
      promptableTexts([
        'indicação do ano 2027',
        'a data 12/04 no rodapé',
        'tira o 2027 do ovo',
        'coloca 3 coelhos',
        'tema de ano novo',
      ]),
    ).toEqual(['tira o 2027 do ovo', 'coloca 3 coelhos', 'tema de ano novo']);
  });
});

describe('G3 em todo campo que vai ao modelo (R2, R3, D-45)', () => {
  const change = (what_to_change: string, extra = {}) =>
    directorPlan({ turn_kind: 'pedido_item', will_change_image: true, what_to_change, ...extra });

  it('R2: what_to_change com escrita e preço refaz, e persistindo vira recusa, sem chamada de imagem', () => {
    const plan = change('escrever FELIZ PASCOA em letras grandes no topo; colocar o preco R$ 9,90');
    expect(checkPainted(plan, { final: false })).toMatchObject({ kind: 'retry' });
    expect(checkPainted(plan, { final: true })).toMatchObject({
      kind: 'ok',
      plan: { turn_kind: 'recusa_pintado', refusal: 'painted_price', will_change_image: false },
    });
  });

  it('R2: o segundo plano, sem a escrita, segue', () => {
    const plan = change('colocar mais flores no campo');
    expect(checkPainted(plan, { final: true })).toEqual({ kind: 'ok', plan });
  });

  it('R2: inventory_keep perde o item com conteúdo pintado, sem refazer, e o resto fica', () => {
    const plan = change('mais flores', {
      inventory_keep: ['titulo Feliz Pascoa', 'logo da loja', 'preco R$ 9,90', 'coelho'],
    });
    const result = checkPainted(plan, { final: false });
    expect(result).toMatchObject({ kind: 'ok', plan: { inventory_keep: ['coelho'] } });
  });

  it.each([
    'trocar o preço pintado por flores',
    'abrir espaço para os preços',
    'deixar o fundo atrás do título mais claro',
    'deixar sem texto legível',
    'tira o preço',
    'preciso de lugar pros preços',
    'reservar uma área livre para o título',
  ])('Mencionar não é pedir escrita: "%s" não é recusado nem refeito', (text) => {
    expect(paintedKindOf(text)).toBeNull();
    const plan = change(text);
    expect(checkPainted(plan, { final: false })).toEqual({ kind: 'ok', plan });
  });

  it('em "troca X por Y", só o Y conta', () => {
    expect(paintedKindOf('trocar o coelho por um preço R$ 9,90')).toBe('painted_price');
  });

  it('o trecho que tira não protege o trecho que escreve', () => {
    expect(paintedKindOf('tira o preço e escreve OFERTA')).toBe('painted_text');
  });

  it.each([
    ['uma placa escrita FELIZ PASCOA', 'painted_text'],
    ['uma placa com a frase Feliz Pascoa', 'painted_text'],
    ['faixa com os dizeres OFERTA', 'painted_text'],
    ['selo 50% off', 'painted_price'],
    ['titulo Ofertas da Semana', 'painted_text'],
    ['uma placa com a palavra Bem-vindo', 'painted_text'],
    ['um slogan embaixo', 'painted_text'],
  ])('R3: what_to_put "%s" é %s', (what, kind) => {
    expect(paintedKindOf(what)).toBe(kind);
    expect(enforcePaintedRefusal(item(what)).refusal).toBe(kind);
  });

  it('R3: uma TV em caixa alta curta não é texto', () => {
    expect(paintedKindOf('uma TV na parede')).toBeNull();
  });

  it('R3: item "uma placa escrita FELIZ PASCOA" não vai ao prompt nem ao "marquei"', () => {
    expect(promptableTexts(['uma placa escrita FELIZ PASCOA', 'um rio', 'selo 50% off'])).toEqual([
      'um rio',
    ]);
  });

  it('D-45: written_content preenchido vira recusa, ainda que nenhum termo seja conhecido', () => {
    const plan = item('uma placa de boas-vindas');
    expect(paintedKindOf(plan.what_to_put)).toBeNull();
    expect(enforcePaintedRefusal({ ...plan, written_content: ['Bem-vindo'] })).toMatchObject({
      turn_kind: 'recusa_pintado',
      refusal: 'painted_text',
      will_change_image: false,
    });
  });

  it('D-45: pedido disfarçado com written_content vazio segue (escapa, e o juiz relata)', () => {
    const plan = item('uma placa de boas-vindas');
    expect(enforcePaintedRefusal(plan)).toBe(plan);
  });
});
