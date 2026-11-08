import { decideTurn } from '../domain/scene-director-decision';
import { FIXED_ANNOUNCEMENT } from '../domain/scene-director-phrases';
import { DirectorPlan } from '../domain/scene-director-schema';
import { SceneDirectorService } from '../services/scene-director.service';
import {
  directorContextFor,
  directorPlan,
  directorReturning,
  PlanOverrides,
} from '../testing/scene-director-fixtures';
import { runDirector } from './scene-director-run';

/** Validação 9: o anúncio só promete o que o plano traz; persistindo, a imagem segue com o texto fixo. */
const imagePlan = (over: PlanOverrides): PlanOverrides => ({
  turn_kind: 'pedido_item',
  will_change_image: true,
  ...over,
});

const announced = async (plan: PlanOverrides, message: string) => {
  const { director, run } = directorReturning(imagePlan(plan));
  const { outcome } = await runDirector(director, {
    context: directorContextFor(message),
    correlationId: 'c',
  });
  if (outcome.kind !== 'plan') throw new Error(`esperava plano, veio ${outcome.kind}`);
  const decision = decideTurn({
    plan: outcome.plan,
    marked: false,
    hasImage: true,
    openRequests: [],
  });
  return { run, outcome, decision };
};

describe('Anúncio contra o plano (validação 9)', () => {
  it('Anúncio promete escrita que o plano não traz: a imagem segue, com o texto fixo', async () => {
    const result = await announced(
      {
        reply: 'Vou dar um efeito realista de gravação na placa',
        what_to_change: 'Add a wooden sign with a realistic engraved look',
      },
      'coloca uma placa de madeira',
    );
    expect(result.run).toHaveBeenCalledTimes(2);
    expect(result.run.mock.calls[1][0].text).toContain('o anúncio anuncia escrita');
    expect(result.decision).toMatchObject({ kind: 'image', announcement: FIXED_ANNOUNCEMENT });
    expect(result.outcome.patches?.announcement?.before).toContain('gravação');
  });

  it('Anúncio cita frase cortada: o trecho tirado de image.change deixa o anúncio sem fonte', async () => {
    const result = await announced(
      {
        reply: 'Vou colocar uma placa com “SALE 50% OFF”',
        what_to_change: 'Add a wooden sign reading “SALE 50% OFF” near the bottom',
      },
      'coloca uma placa de madeira',
    );
    const plan: DirectorPlan = result.outcome.plan;
    expect(plan.image?.change).not.toContain('SALE');
    expect(result.outcome.patches?.text).toHaveLength(1);
    expect(result.decision).toMatchObject({ kind: 'image', announcement: FIXED_ANNOUNCEMENT });
  });

  it('o anúncio fiel ao plano segue como o Diretor escreveu, sem refazer', async () => {
    const reply = 'Vou colocar uma placa de madeira com a frase “Promoção de Páscoa” no rodapé';
    const result = await announced(
      {
        reply,
        what_to_change: 'Add a wooden sign near the bottom',
        exact_text: ['Promoção de Páscoa'],
      },
      'coloca uma placa com "Promoção de Páscoa" no rodapé',
    );
    expect(result.run).toHaveBeenCalledTimes(1);
    expect(result.decision).toMatchObject({ kind: 'image', announcement: reply });
    expect(result.outcome.patches).toBeUndefined();
  });

  it('o anúncio inválido na primeira chamada e certo na segunda segue com o da segunda', async () => {
    const reply = (text: string) => ({
      ok: true,
      text: JSON.stringify(
        directorPlan(imagePlan({ reply: text, what_to_change: 'Add a wooden sign' })),
      ),
      costUsd: 0.0004,
      requestId: 'req',
      latencyMs: 5,
    });
    const run = jest
      .fn()
      .mockResolvedValueOnce(reply('Vou deixar a frase escrita na madeira'))
      .mockResolvedValueOnce(reply('Vou colocar uma placa de madeira'));
    const { outcome } = await runDirector({ run } as unknown as SceneDirectorService, {
      context: directorContextFor('coloca uma placa de madeira'),
      correlationId: 'c',
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      kind: 'plan',
      plan: { reply: 'Vou colocar uma placa de madeira' },
    });
  });
});
