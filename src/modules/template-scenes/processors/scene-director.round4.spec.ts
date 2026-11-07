import { directorPlan } from '../testing/scene-director-fixtures';
import { DirectorPlan } from '../domain/scene-director-schema';
import { DirectorContext } from '../services/scene-director-context';
import { SceneDirectorService } from '../services/scene-director.service';
import { runDirector } from './scene-director-run';

/** Task 1.44, pelo caminho do Diretor com o modelo simulado: a mesma resposta nas duas chamadas, sem banco. */
const item = (extra: Partial<DirectorPlan>): Partial<DirectorPlan> => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  reply: 'Vou fazer a mudança.',
  ...extra,
});

async function run(plan: Partial<DirectorPlan>) {
  const text = JSON.stringify(directorPlan(plan));
  const call = jest.fn(async () => ({
    ok: true as const,
    text,
    costUsd: 0,
    requestId: null,
    latencyMs: 1,
  }));
  const context: DirectorContext = {
    text: 'pedido',
    image: null,
    script: { message: 'pedido' } as DirectorContext['script'],
    clientMessages: ['pedido'],
    briefItems: [],
  };
  const result = await runDirector({ run: call } as unknown as SceneDirectorService, {
    context,
    correlationId: 'round4',
  });
  return { outcome: result.outcome, calls: call.mock.calls.length };
}

describe('Rodada 4 pelo runDirector', () => {
  it('nome depois do título: pergunta fixa nas duas chamadas', async () => {
    const { outcome, calls } = await run(
      item({
        what_to_change: 'Remover o título atual',
        what_to_put: 'o título Promoção de Páscoa',
      }),
    );
    expect(outcome.kind).toBe('painted_question');
    expect(calls).toBe(2);
  });

  it('título citado como referência segue, em 1 chamada', async () => {
    const { outcome, calls } = await run(
      item({
        what_to_change: 'Remover o título da parte superior',
        what_to_put: 'flores sobre o título decorativo',
      }),
    );
    expect(outcome).toMatchObject({ kind: 'plan', plan: { turn_kind: 'pedido_item' } });
    expect(calls).toBe(1);
  });

  it('título citado sem o título removido: pergunta fixa', async () => {
    const { outcome } = await run(
      item({ what_to_change: 'tirar o coelho', what_to_put: 'o título decorativo' }),
    );
    expect(outcome.kind).toBe('painted_question');
  });

  it.each(['Remover o coelho e acrescentar R$ 9,90', 'Remover o coelho e acrescentar 50% off'])(
    'escrita depois da remoção com outro verbo: "%s" vira recusa, em 1 chamada',
    async (text) => {
      const { outcome, calls } = await run(item({ what_to_change: text }));
      expect(outcome).toMatchObject({ kind: 'plan', plan: { turn_kind: 'recusa_pintado' } });
      expect(calls).toBe(1);
    },
  );

  it.each(['Remover o coelho e inserir OFERTA', 'Remover o coelho e desenhar FELIZ PASCOA'])(
    'forma em caixa alta com outro verbo: "%s" não segue, nas duas chamadas',
    async (text) => {
      const { outcome } = await run(item({ what_to_change: text }));
      const refused = outcome.kind === 'plan' && outcome.plan.turn_kind === 'recusa_pintado';
      expect(refused || outcome.kind === 'painted_question').toBe(true);
    },
  );

  it('outro verbo depois da remoção, sem escrita, segue', async () => {
    const { outcome, calls } = await run(
      item({ what_to_change: 'Remover o coelho e acrescentar flores' }),
    );
    expect(outcome).toMatchObject({ kind: 'plan', plan: { turn_kind: 'pedido_item' } });
    expect(calls).toBe(1);
  });

  it.each([
    'Encontrei dois coelhos. Qual deles?',
    'Só encontrei um ovo.',
    'Procurei e não vejo cerca.',
  ])('resposta no passado "%s" não é anúncio: 1 chamada, resposta do Diretor', async (reply) => {
    const { outcome, calls } = await run(item({ will_change_image: false, reply }));
    expect(outcome).toMatchObject({ kind: 'plan', plan: { reply } });
    expect(calls).toBe(1);
  });

  it('anúncio no futuro refaz e, persistindo, pergunta o que mudar', async () => {
    const { outcome, calls } = await run(
      item({ will_change_image: false, reply: 'Removerei o coelho.' }),
    );
    expect(outcome.kind).toBe('instruction_question');
    expect(calls).toBe(2);
  });

  it.each([
    ['20% para a direita'],
    ['30% acima'],
    ['10 para cima'],
    ['1,50 acima'],
    ['1 à esquerda e 1 à direita'],
  ])('deslocamento "%s" segue, sem recusa', async (put) => {
    const { outcome } = await run(item({ what_to_change: 'Mover o coelho', what_to_put: put }));
    expect(outcome).toMatchObject({ kind: 'plan', plan: { turn_kind: 'pedido_item' } });
  });

  it.each(['3 no canto', '99 no canto', '12,50 no canto'])(
    'número solto "%s" vira recusa',
    async (put) => {
      const { outcome } = await run(item({ what_to_change: 'Mover o coelho', what_to_put: put }));
      expect(outcome).toMatchObject({ kind: 'plan', plan: { turn_kind: 'recusa_pintado' } });
    },
  );
});
