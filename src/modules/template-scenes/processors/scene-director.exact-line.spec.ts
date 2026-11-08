import {
  directorContextFor,
  directorReturning,
  PlanOverrides,
} from '../testing/scene-director-fixtures';
import { DirectorContext } from '../services/scene-director-context';
import { questionReply } from './scene-director-outcome-reply';
import { runDirector } from './scene-director-run';

/** Rodada 6: a validação 4a só aceita frase inteira, e o preço do cliente seguido de ponto não é "preço fora do bloco". */
const imagePlan = (over: PlanOverrides): PlanOverrides => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou colocar a placa.',
  what_to_change: 'Add a wooden sign',
  ...over,
});

const run = async (plan: PlanOverrides, context: DirectorContext) => {
  const model = directorReturning(plan);
  const { outcome } = await runDirector(model.director, { context, correlationId: 'c' });
  return { outcome, calls: model.run.mock.calls.length };
};

describe('Frase inteira (R63)', () => {
  it.each([
    ['Pedaço de número não serve', 'coloca uma placa com "De R$ 19,90 por R$ 9,90"', 'R$ 1'],
    ['Pedaço de palavra não serve', 'coloca uma placa com "Promoção de Páscoa"', 'Promo'],
    [
      'Entre aspas fora de ordem',
      'coloca uma placa com "Promoção de Páscoa"',
      'Páscoa de Promoção',
    ],
  ])(
    '%s: nenhuma imagem, o Diretor é chamado duas vezes e o chat pergunta o texto',
    async (_n, message, line) => {
      const result = await run(imagePlan({ exact_text: [line] }), directorContextFor(message));
      expect(result.calls).toBe(2);
      expect(result.outcome.kind).toBe('exact_text_question');
    },
  );

  it('a frase inteira entre aspas segue na primeira chamada', async () => {
    const result = await run(
      imagePlan({ exact_text: ['Promoção de Páscoa'] }),
      directorContextFor('coloca uma placa com "Promoção de Páscoa"'),
    );
    expect(result).toMatchObject({ calls: 1, outcome: { kind: 'plan' } });
  });
});

describe('Preço invertido', () => {
  it('Preço invertido não passa: a junção não monta "De R$ 12,49 por R$ 19,90"', async () => {
    const context = directorContextFor('muda só o preço final para R$ 12,49', {
      paintedText: ['De R$ 19,90 por R$ 9,90'],
    });
    const result = await run(imagePlan({ exact_text: ['De R$ 12,49 por R$ 19,90'] }), context);
    expect(result).toMatchObject({ calls: 2, outcome: { kind: 'exact_text_question' } });
  });

  it('Preço invertido escrito pelo cliente: igual ao trecho entre aspas, o plano segue', async () => {
    const context = directorContextFor('coloca uma placa com "De R$ 9,90 por R$ 19,90"');
    const result = await run(imagePlan({ exact_text: ['De R$ 9,90 por R$ 19,90'] }), context);
    expect(result).toMatchObject({ calls: 1, outcome: { kind: 'plan' } });
  });
});

describe('Preço seguido de ponto (R64)', () => {
  it('o change que termina no preço do cliente com ponto segue na primeira chamada, sem cortar o preço', async () => {
    const message =
      'Troca o texto da placa para "Oferta de Páscoa" e embaixo, em outra linha, "De R$ 19,90 por R$ 9,90".';
    const change =
      'Replace the sign text with two centered lines: Oferta de Páscoa, then De R$ 19,90 por R$ 9,90.';
    const result = await run(
      imagePlan({
        what_to_change: change,
        exact_text: ['Oferta de Páscoa', 'De R$ 19,90 por R$ 9,90'],
      }),
      directorContextFor(message),
    );
    expect(result.calls).toBe(1);
    expect(result.outcome).toMatchObject({ kind: 'plan' });
    expect(result.outcome).not.toHaveProperty('patches');
    const plan = (result.outcome as { plan: { image: { change: string } } }).plan;
    expect(plan.image.change).toBe(change);
  });
});

describe('Texto da camada que vai ser pintada (D-55)', () => {
  const context = () =>
    directorContextFor('eu queria um efeito como se tivesse sido escrito na madeira', {
      layerTexts: ['Promoção de Páscoa'],
    });

  it('a frase igual ao texto da camada segue sem pergunta', async () => {
    const result = await run(imagePlan({ exact_text: ['Promoção de Páscoa'] }), context());
    expect(result).toMatchObject({ calls: 1, outcome: { kind: 'plan' } });
  });

  it('Camada não serve de fonte para outra frase: pergunta o texto exato', async () => {
    const result = await run(imagePlan({ exact_text: ['Páscoa de Promoção'] }), context());
    expect(result).toMatchObject({ calls: 2, outcome: { kind: 'exact_text_question' } });
  });
});

/** R84 e R85: sem trava de código (PV-111 revisado), a contradição é só do prompt; duas linhas não viram "qual das duas". */
describe('Duas linhas sem trava de código (R84, R85)', () => {
  const placa = (lines: string[]) =>
    imagePlan({
      exact_text: lines,
      what_to_change: 'Add a wooden sign with the requested lettering',
    });

  it('R84: "sim, faz" com item de duas linhas pedido em turno anterior gera plano, sem refação', async () => {
    const context = directorContextFor('sim, faz', {
      clientMessages: ['coloca uma placa com "Oferta de Páscoa" e embaixo "Compre já"'],
    });
    const result = await run(placa(['Oferta de Páscoa', 'Compre já']), context);
    expect(result).toMatchObject({ calls: 1, outcome: { kind: 'plan' } });
  });

  it('R84: resposta a pergunta, com as duas linhas pedidas antes, gera plano', async () => {
    const context = directorContextFor('Oferta de Páscoa e Compre já', {
      clientMessages: ['coloca uma placa com título e subtítulo', 'Oferta de Páscoa e Compre já'],
    });
    const result = await run(placa(['Oferta de Páscoa', 'Compre já']), context);
    expect(result).toMatchObject({ calls: 1, outcome: { kind: 'plan' } });
  });

  it('R85: linhas inventadas pelo Diretor voltam a perguntar o texto exato', async () => {
    const context = directorContextFor('coloca uma placa de oferta no rodapé');
    const result = await run(placa(['Oferta', 'Aproveite']), context);
    expect(result).toMatchObject({ calls: 2, outcome: { kind: 'exact_text_question' } });
    expect(questionReply(result.outcome)).toContain('Qual é o texto exato');
  });

  it('R85: frase única quebrada pelo Diretor em duas linhas não vira "qual das duas"', async () => {
    const context = directorContextFor('coloca uma placa escrita Promoção de Páscoa imperdível');
    const result = await run(placa(['Promoção de Páscoa', 'imperdível']), context);
    expect(result.outcome.kind).not.toBe('contradiction_question');
    expect(questionReply(result.outcome) ?? '').not.toContain('Qual vai na imagem');
  });
});
