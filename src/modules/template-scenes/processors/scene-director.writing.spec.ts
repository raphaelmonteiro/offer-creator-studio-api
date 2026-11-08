import { decideTurn } from '../domain/scene-director-decision';
import { DirectorContext } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { directorPlan, PlanOverrides } from '../testing/scene-director-fixtures';
import { runDirector } from './scene-director-run';

/**
 * D-51: o código não recusa pedido de escrita nem faz pergunta de escrita (a medida 1.45 mostrou que o detector só
 * causava falsa recusa). O modelo simulado devolve um plano de imagem para cada frase, e a frase chega à imagem.
 */
const contextFor = (message: string, over: Partial<DirectorContext> = {}): DirectorContext => ({
  text: '',
  image: null,
  script: {
    message,
    hasImage: true,
    marked: false,
    openRequests: [],
    layers: [],
    hasLogoAttachment: false,
  },
  clientMessages: [message],
  briefItems: [],
  paintedText: [],
  ...over,
});

const modelReturning = (plan: PlanOverrides) => {
  const run = jest.fn().mockResolvedValue({
    ok: true,
    text: JSON.stringify(directorPlan(plan)),
    costUsd: 0.0004,
    requestId: 'req',
    latencyMs: 5,
  });
  return { director: { run } as unknown as SceneDirectorService, run };
};

const imagePlan = (over: PlanOverrides = {}): PlanOverrides => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou fazer a mudança.',
  what_to_change: 'Make the requested change',
  ...over,
});

/** As frases de R38 a R53 (rodadas 4 e 5), as do grupo N da 1.45 e as da spec: todas pedido normal. */
const NORMAL_PHRASES = [
  'Remover o título escrito na parte superior central.',
  'tira o coelho e o título mostrado no topo',
  'tira a placa mostrando 50% off',
  'tira a placa e o texto aplicado',
  'tira o ovo e as letras desenhadas',
  'quero os ovos lisos, sem números escritos',
  'deixa a placa sem nada escrito',
  'deixa o coelho 1,5 vezes maior',
  'deixa o coelho 1,50 maior',
  'coloca opacidade 0,75 no fundo',
  'coloca um castelo legendário lá no fundo',
  'coloca umas flores logo depois da cerca',
  'faz umas marcas de patas na areia',
  'deixa espaço pra colocar o texto depois',
  'reserva um lugar para o preço',
  'tira esse preço',
  'tira o selo e o 2027',
  'troca o 2027 por flores',
  'faz o coelho ocupar 1/3 da imagem',
];

describe('Pedido normal não vira recusa nem pergunta', () => {
  it.each(NORMAL_PHRASES)('"%s" chega à imagem, com uma chamada', async (phrase) => {
    const { director, run } = modelReturning(imagePlan());
    const { outcome, calls } = await runDirector(director, {
      context: contextFor(phrase),
      correlationId: 'c',
    });
    expect(outcome.kind).toBe('plan');
    expect(run).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const plan = (outcome as { plan: ReturnType<typeof directorPlan> }).plan;
    expect(plan.turn_kind).toBe('pedido_item');
    expect(decideTurn({ plan, marked: false, hasImage: true, openRequests: [] })).toMatchObject({
      kind: 'image',
    });
  });
});

describe('Escrever é pedido válido', () => {
  it.each([
    ['escreve FELIZ PASCOA em cima', ['FELIZ PASCOA']],
    ['pinta o texto OFERTA DA SEMANA no topo', ['OFERTA DA SEMANA']],
    ['coloca o preço R$ 9,90 num selo', ['R$ 9,90']],
    ['um selo de 50% de desconto', ['50% de desconto']],
    ['faz uma faixa "Feliz Natal"', ['Feliz Natal']],
  ])(
    '"%s": a frase vai literal em exact_text, sem recusa e sem pergunta',
    async (phrase, lines) => {
      const { director, run } = modelReturning(imagePlan({ exact_text: lines }));
      const { outcome } = await runDirector(director, {
        context: contextFor(phrase),
        correlationId: 'c',
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({ kind: 'plan' });
      expect(
        (outcome as { plan: { image: { exact_text: string[] } } }).plan.image.exact_text,
      ).toEqual(lines);
    },
  );

  it.each([
    ['coloca um aviso de fechado', '"Fechado"', 'Fechado'],
    ['um quadro com os dizeres boa páscoa', '“boa páscoa”', 'boa páscoa'],
    ['juntar o texto promoçao de pascoa na placa', '“Promoção de Páscoa”', 'Promoção de Páscoa'],
  ])(
    '"%s": o Diretor embrulha a linha em aspas e o código as tira, sem refazer',
    async (phrase, wrapped, clean) => {
      const { director, run } = modelReturning(imagePlan({ exact_text: [wrapped] }));
      const { outcome } = await runDirector(director, {
        context: contextFor(phrase),
        correlationId: 'c',
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(
        (outcome as { plan: { image: { exact_text: string[] } } }).plan.image.exact_text,
      ).toEqual([clean]);
    },
  );

  it('Pedido de escrita disfarçado: a placa sem exact_text segue, e nada é recusado', async () => {
    const { director } = modelReturning(imagePlan({ what_to_change: 'Add a welcome sign' }));
    const { outcome } = await runDirector(director, {
      context: contextFor('coloca uma placa de boas-vindas'),
      correlationId: 'c',
    });
    expect(outcome.kind).toBe('plan');
  });
});

describe('Logo é sempre camada', () => {
  it('Integrar a logo: a recusa é só da logo, e o código a respeita sem refazer', async () => {
    const { director, run } = modelReturning({
      turn_kind: 'recusa_pintado',
      will_change_image: false,
      refusal: 'painted_logo',
      reply: 'Não dá.',
    });
    const { outcome } = await runDirector(director, {
      context: contextFor('integra a logo na imagem'),
      correlationId: 'c',
    });
    expect(run).toHaveBeenCalledTimes(1);
    const plan = (outcome as { plan: ReturnType<typeof directorPlan> }).plan;
    expect(decideTurn({ plan, marked: false, hasImage: true, openRequests: [] })).toEqual({
      kind: 'refuse',
      refusal: 'painted_logo',
    });
  });
});
