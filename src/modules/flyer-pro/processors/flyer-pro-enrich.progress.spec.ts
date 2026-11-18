import { jobRow } from '../services/flyer-pro-jobs.service.testutil';
import { progressOf } from './flyer-pro-enrich.progress';
import type { UnitPlan } from './flyer-pro-enrich.types';

const item = (id: string) => ({ id, position: 1 }) as never;
const usage = (model: string | null, costUsd: number | null) => ({
  model,
  models: model ? [model] : [],
  calls: 1,
  inputTokens: 1000,
  outputTokens: 200,
  costUsd,
});

function plan(over: Partial<UnitPlan> & { items?: number } = {}): UnitPlan {
  const { items = 2, ...rest } = over;
  return {
    phase: 'categorize',
    work: {
      phase: 'categorize',
      items: Array.from({ length: items }, (_, i) => item(`i${i}`)),
      verdicts: [],
    },
    batchSize: 40,
    skipped: false,
    skippedItems: 0,
    usage: usage('gpt-6-luna', 0.0002),
    totalMs: 100,
    providerMs: 90,
    ...rest,
  } as UnitPlan;
}

describe('o que um lote soma ao job (progressOf)', () => {
  it('categorias: contagens, processed, o modelo do uso e o custo somado', () => {
    const { columns, cost } = progressOf(jobRow({ processed: 3 }), plan(), {
      applied: 1,
      unchanged: 1,
    });

    expect(columns.processed).toBe(5);
    expect(columns.result.categorize).toMatchObject({ visited: 2, applied: 1, unchanged: 1 });
    expect(columns.models).toEqual({ categorize: 'gpt-6-luna' });
    expect(columns.costUsd).toBe(0.0002);
    expect(cost.unknown).toBe(false);
    expect(columns).toMatchObject({ batchAttempts: 0, clearHeartbeat: true });
  });

  it('fase pulada: soma os itens que ela pegaria, sem modelo e sem custo', () => {
    const skipped = plan({ work: null, skipped: true, skippedItems: 78, usage: null });
    const { columns } = progressOf(jobRow({ processed: 0 }), skipped, null);

    expect(columns.processed).toBe(78);
    expect(columns.result.categorize).toMatchObject({ skipped: 'AI_DISABLED' });
    expect(columns.models ?? {}).not.toHaveProperty('categorize');
    expect(columns.costUsd).toBeNull();
  });

  it('usage sem preço: costUsd nulo e a marca de desconhecido sobe', () => {
    const { columns, cost } = progressOf(jobRow(), plan({ usage: usage('gpt-4o', null) }), {});
    expect(columns.costUsd).toBeNull();
    expect(cost.unknown).toBe(true);
    expect(columns.models).toEqual({ categorize: 'gpt-4o' });
  });

  it('fotos: nameSearchUnavailable e eanBudgetBlocked entram em result.image_match', () => {
    const photos = plan({
      phase: 'image_match',
      work: {
        phase: 'image_match',
        items: [item('a'), item('b')],
        verdicts: [],
        nameSearchUnavailable: true,
      },
    });
    const { columns } = progressOf(jobRow(), photos, { applied: 1, eanBudgetBlocked: 1 });

    expect(columns.result.image_match).toMatchObject({
      visited: 2,
      applied: 1,
      nameSearchUnavailable: true,
      eanBudgetBlocked: 1,
    });
  });

  it('fotos com a busca por nome disponível: o campo fica ausente', () => {
    const photos = plan({
      phase: 'image_match',
      work: { phase: 'image_match', items: [item('a')], verdicts: [] },
    });
    const { columns } = progressOf(jobRow(), photos, {});
    expect(columns.result.image_match).not.toHaveProperty('nameSearchUnavailable');
    expect(columns.result.image_match).not.toHaveProperty('eanBudgetBlocked');
  });

  describe('passada do EAN pendente', () => {
    const retry = (counts: Record<string, number>) => {
      const current = jobRow({
        processed: 234,
        result: {
          image_match: {
            visited: 78,
            applied: 60,
            review: 9,
            notFound: 6,
            eanPending: 3,
            skipped: null,
          },
        },
      });
      const pass = plan({
        phase: 'image_ean_retry',
        work: { phase: 'image_match', items: [item('a'), item('b'), item('c')], verdicts: [] },
      });
      return progressOf(current, pass, counts).columns;
    };

    it('não soma em processed nem em visited: o item que sai de pendente troca de contagem', () => {
      const columns = retry({ applied: 1 });

      expect(columns.processed).toBe(234);
      expect(columns.result.image_match).toMatchObject({
        visited: 78,
        applied: 61,
        eanPending: 2,
      });
    });

    it('o tempo vai para timing.image_ean_retry e o modelo para models.image_ean_retry', () => {
      const columns = retry({});

      expect(columns.result.timing?.image_ean_retry).toEqual({
        batches: 1,
        totalMs: 100,
        maxMs: 100,
      });
      expect(columns.result.timing).not.toHaveProperty('image_match');
      expect(columns.models).toMatchObject({ image_ean_retry: 'gpt-6-luna' });
    });

    it('item que continua pendente não muda nenhuma contagem', () => {
      const columns = retry({});
      expect(columns.result.image_match).toMatchObject({
        applied: 60,
        review: 9,
        notFound: 6,
        eanPending: 3,
      });
    });
  });
});
