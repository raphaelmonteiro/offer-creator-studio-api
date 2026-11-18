import { readEnrichConfig } from '../config/flyer-pro-enrich.config';
import { fakeConfig } from '../../ai/utils/openai-chat.testutil';
import {
  addCounts,
  addTiming,
  batchSizeOf,
  effectiveOnlyMissing,
  enrichError,
  failureDecision,
  finalFields,
  isActiveStatus,
  isStalled,
  markSkipped,
  needsAnotherRound,
  nextPhase,
  orderedSteps,
  retryDelaySeconds,
  runnablePhases,
  withModel,
} from './flyer-pro-enrich-rules';
import type { JobStatus } from './flyer-pro-job.types';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const secondsAgo = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const config = readEnrichConfig(fakeConfig({}), { warn: jest.fn() });

describe('ordem fixa das fases', () => {
  it('orderedSteps põe as fases na ordem fixa, sem repetição, qualquer que seja a enviada', () => {
    expect(orderedSteps(['image_match', 'categorize'])).toEqual(['categorize', 'image_match']);
    expect(orderedSteps(['image_match', 'spellcheck', 'categorize'])).toEqual([
      'categorize',
      'spellcheck',
      'image_match',
    ]);
    expect(orderedSteps(['spellcheck', 'spellcheck', 'translate'])).toEqual(['spellcheck']);
  });

  it('nextPhase: a primeira sem fase atual, a seguinte pulando as que não foram pedidas, null depois da última', () => {
    const phases = ['categorize', 'image_match'] as const;

    expect(nextPhase(phases, null)).toBe('categorize');
    expect(nextPhase(phases, 'categorize')).toBe('image_match');
    expect(nextPhase(phases, 'image_match')).toBeNull();
    expect(nextPhase([], null)).toBeNull();
  });

  it('só fotos: a primeira fase é image_match', () => {
    expect(nextPhase(['image_match'], null)).toBe('image_match');
  });

  it('a fase pulada (AI_DISABLED) fica fora das fases que ainda valem', () => {
    const result = markSkipped({}, 'categorize');

    expect(runnablePhases(['categorize', 'spellcheck', 'image_match'], result)).toEqual([
      'spellcheck',
      'image_match',
    ]);
  });

  it('tamanho do lote por fase, da configuração', () => {
    expect([
      batchSizeOf('categorize', config),
      batchSizeOf('spellcheck', config),
      batchSizeOf('image_match', config),
    ]).toEqual([40, 40, 16]);
  });
});

describe('conferência final', () => {
  it.each([
    [1, 2, true],
    [2, 1, true],
    [3, 5, false],
    [1, 0, false],
  ])('rodada %s com %s itens a fazer: outra rodada? %s', (round, pending, expected) => {
    expect(needsAnotherRound(round, pending)).toBe(expected);
  });

  it('da segunda rodada em diante o critério é sempre o de onlyMissing ligado', () => {
    expect(effectiveOnlyMissing(false, 1)).toBe(false);
    expect(effectiveOnlyMissing(false, 2)).toBe(true);
    expect(effectiveOnlyMissing(true, 1)).toBe(true);
  });
});

describe('estados do job', () => {
  const ALL: JobStatus[] = ['queued', 'running', 'done', 'failed', 'canceled'];

  it('queued e running são ativos; done, failed e canceled são finais', () => {
    expect(ALL.filter(isActiveStatus)).toEqual(['queued', 'running']);
  });

  it('done zera a fase; failed e canceled guardam a fase em que o job parou', () => {
    expect(finalFields('done', 'image_match')).toEqual({ status: 'done', phase: null });
    expect(finalFields('failed', 'image_match')).toEqual({
      status: 'failed',
      phase: 'image_match',
    });
    expect(finalFields('canceled', 'spellcheck')).toEqual({
      status: 'canceled',
      phase: 'spellcheck',
    });
    expect(finalFields('canceled', null).phase).toBeNull();
  });
});

describe('stalled', () => {
  const job = (over: Partial<Parameters<typeof isStalled>[0]>) => ({
    status: 'running' as JobStatus,
    updatedAt: secondsAgo(500),
    heartbeatAt: null,
    ...over,
  });

  it.each([
    ['sem batimento e 181 s de atividade', job({ updatedAt: secondsAgo(181) }), true],
    ['sem batimento e 180 s exatos', job({ updatedAt: secondsAgo(180) }), false],
    ['batimento há 10 s mesmo com updatedAt antigo', job({ heartbeatAt: secondsAgo(10) }), false],
    ['queued parado há 200 s', job({ status: 'queued', updatedAt: secondsAgo(200) }), true],
    ['done há 2 horas', job({ status: 'done', updatedAt: secondsAgo(7200) }), false],
    ['failed há 2 horas', job({ status: 'failed', updatedAt: secondsAgo(7200) }), false],
    ['canceled há 2 horas', job({ status: 'canceled', updatedAt: secondsAgo(7200) }), false],
  ])('%s', (_, input, expected) => {
    expect(isStalled(input, NOW)).toBe(expected);
  });
});

describe('falha do provedor', () => {
  it('a primeira repetição espera 15 s, a segunda 60 s, e acabaram as repetições', () => {
    expect([1, 2, 3].map(retryDelaySeconds)).toEqual([15, 60, null]);
  });

  it.each([
    [1, 3, false, 'retry'],
    [2, 3, false, 'retry'],
    [3, 3, false, 'fail'],
    [1, 3, true, 'fail'],
    [1, 1, false, 'fail'],
  ] as const)(
    'tentativa %s de %s, terminal %s: %s',
    (attempts, maxAttempts, terminal, expected) => {
      expect(failureDecision({ attempts, maxAttempts, terminal })).toBe(expected);
    },
  );

  it('o erro do job leva o texto em pt-BR do código', () => {
    expect(enrichError('AI_PROVIDER_ERROR', 'image_match')).toEqual({
      code: 'AI_PROVIDER_ERROR',
      phase: 'image_match',
      message: 'O serviço de IA não respondeu. Os itens que faltam continuam para conferir.',
    });
    expect(enrichError('JOB_STALLED', null).message).toBe(
      'O processamento parou três vezes seguidas.',
    );
    expect(enrichError('INTERNAL', null).message).toBe('Erro inesperado no processamento.');
  });
});

describe('result e models', () => {
  it('addCounts: a fase nasce zerada, soma lote a lote e nunca perde o que já tinha', () => {
    const first = addCounts({}, 'categorize', {
      visited: 40,
      applied: 5,
      suggested: 3,
      unchanged: 32,
    });
    const second = addCounts(first, 'categorize', {
      visited: 38,
      applied: 4,
      suggested: 1,
      unchanged: 33,
    });

    expect(second.categorize).toEqual({
      visited: 78,
      applied: 9,
      suggested: 4,
      unchanged: 65,
      skipped: null,
    });
  });

  it('addCounts: ortografia e fotos têm as próprias contagens, e as outras fases ficam como estavam', () => {
    const spelled = addCounts({}, 'spellcheck', { visited: 40, suggested: 2, clean: 38 });
    const photos = addCounts(spelled, 'image_match', {
      visited: 16,
      applied: 12,
      review: 2,
      notFound: 2,
    });

    expect(photos.spellcheck).toEqual({ visited: 40, suggested: 2, clean: 38, skipped: null });
    expect(photos.image_match).toEqual({
      visited: 16,
      applied: 12,
      review: 2,
      notFound: 2,
      eanPending: 0,
      skipped: null,
    });
  });

  it('markSkipped marca AI_DISABLED sem tocar nas contagens', () => {
    expect(markSkipped({}, 'spellcheck').spellcheck).toEqual({
      visited: 0,
      suggested: 0,
      clean: 0,
      skipped: 'AI_DISABLED',
    });
  });

  describe('timing', () => {
    it('soma, máximo e contagem por fase, só dos lotes com item', () => {
      let result = addTiming({}, 'image_match', { items: 16, durationMs: 100 });
      result = addTiming(result, 'image_match', { items: 16, durationMs: 300 });
      result = addTiming(result, 'image_match', { items: 14, durationMs: 200 });

      expect(result.timing?.image_match).toEqual({ batches: 3, totalMs: 600, maxMs: 300 });
    });

    it('lote sem item (fase vazia) não conta', () => {
      const before = addTiming({}, 'categorize', { items: 40, durationMs: 50 });

      expect(addTiming(before, 'categorize', { items: 0, durationMs: 999 })).toEqual(before);
      expect(addTiming({}, 'categorize', { items: 0, durationMs: 5 })).toEqual({});
    });

    it('lote retomado: o acumulado dos lotes gravados fica, e as fases são independentes', () => {
      let result = addTiming({}, 'image_match', { items: 16, durationMs: 100 });
      result = addTiming(result, 'image_match', { items: 16, durationMs: 100 });
      result = addTiming(result, 'image_match', { items: 16, durationMs: 100 });
      result = addTiming(result, 'image_match', { items: 16, durationMs: 40 });
      result = addTiming(result, 'categorize', { items: 40, durationMs: 7 });

      expect(result.timing?.image_match).toEqual({ batches: 4, totalMs: 340, maxMs: 100 });
      expect(result.timing?.categorize).toEqual({ batches: 1, totalMs: 7, maxMs: 7 });
    });

    it('não mexe nas contagens do result', () => {
      const counted = addCounts({}, 'spellcheck', { visited: 1, clean: 1 });

      expect(addTiming(counted, 'spellcheck', { items: 1, durationMs: 9 }).spellcheck).toEqual(
        counted.spellcheck,
      );
    });
  });

  it('withModel guarda o modelo de cada fase que rodou', () => {
    const models = withModel(withModel(null, 'categorize', 'mock'), 'image_match', 'mock');

    expect(models).toEqual({ categorize: 'mock', image_match: 'mock' });
  });
});
