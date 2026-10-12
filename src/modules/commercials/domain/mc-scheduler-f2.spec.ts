import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { isProjectAssemblyStep, projectAssemblySteps } from './mc-execution-plan';
import { mcQueueForStep } from './mc-pipeline.config';
import { MC_STEP_CREDITS, quotePhase } from './mc-pricing.config';
import { MC_PIPELINE_V2 } from './mc-quality';
import { readySteps, SchedulerScene, SchedulerStep } from './mc-scheduler';
import { McProjectStatus, McSceneStatus, McStepStatus } from './mc-state-machines';
import { McStepType } from './mc-types';

/** Tarefa 6.7 — estados e steps do F2: as mesmas transições do F1 com render_remotion → finalize. */
const f2 = (status: McProjectStatus) => ({
  status,
  pipelineVersion: MC_PIPELINE_V2,
  revision: 1,
  format: 'offer_carousel' as const,
});

const scenes = (n: number, status = McSceneStatus.PENDING): SchedulerScene[] =>
  Array.from({ length: n }, (_, idx) => ({
    id: `s${idx}`,
    idx,
    generation: 1,
    status,
    dialogue: 'fala',
    sceneType: 'talk_tile',
  }));

const step = (
  sceneId: string | null,
  type: McStepType,
  status: McStepStatus,
  extra: Partial<SchedulerStep> = {},
): SchedulerStep => ({
  id: `${sceneId ?? 'proj'}-${type}`,
  sceneId,
  sceneGeneration: sceneId ? 1 : null,
  type,
  status,
  projectRevision: 1,
  attempt: 1,
  ...extra,
});

describe('F2 — plano de projeto, fila e cotação (tarefa 6.7)', () => {
  it('offer_carousel → render_remotion (fila mc.render) → finalize (mc.ffmpeg); ambos steps de projeto da fase assembly', () => {
    expect(projectAssemblySteps('offer_carousel')).toEqual([
      McStepType.RENDER_REMOTION,
      McStepType.FINALIZE,
    ]);
    expect(mcQueueForStep(McStepType.RENDER_REMOTION)).toBe(QUEUES.MC_RENDER);
    expect(mcQueueForStep(McStepType.FINALIZE)).toBe(QUEUES.MC_FFMPEG);
    expect(isProjectAssemblyStep(McStepType.RENDER_REMOTION)).toBe(true);
    expect(MC_STEP_CREDITS[McStepType.RENDER_REMOTION]).toBe(0);
  });

  it('cotação da produção F2 com 6 ofertas: 8 talk (um por fala) + render_remotion + finalize — nunca keyframe/lipsync/assembly', () => {
    const quote = quotePhase(
      'production',
      1,
      Array.from({ length: 8 }, (_, i) => ({
        sceneId: `s${i}`,
        sceneType: 'talk_tile' as const,
        cached: [],
      })),
      { format: 'offer_carousel' },
    );
    const types = quote.items.map((i) => i.stepType);
    expect(types.filter((t) => t === McStepType.TALK)).toHaveLength(8);
    expect(types.slice(-2)).toEqual([McStepType.RENDER_REMOTION, McStepType.FINALIZE]);
    expect(types).not.toEqual(
      expect.arrayContaining([McStepType.KEYFRAME, McStepType.LIPSYNC, McStepType.ASSEMBLY]),
    );
    const preparation = quotePhase(
      'preparation',
      1,
      [{ sceneId: 's0', sceneType: 'talk_tile', cached: [] }],
      { format: 'offer_carousel' },
    );
    expect(preparation.items.map((i) => i.stepType)).toEqual([McStepType.TTS]);
  });
});

describe('F2 — scheduler nunca agenda keyframe nem assembly (tarefa 6.7)', () => {
  it('preparing: só TTS por fala; generating: só talk (depois do TTS); nada de projeto antes das falas prontas', () => {
    const live = scenes(5);
    const prep = live.map((s) =>
      step(s.id, McStepType.TTS, McStepStatus.PENDING, { phase: 'preparation' } as never),
    );
    expect(readySteps(f2(McProjectStatus.PREPARING), live, prep).map((r) => r.type)).toEqual(
      Array(5).fill(McStepType.TTS),
    );
    const production = [
      ...live.map((s) => step(s.id, McStepType.TTS, McStepStatus.SUCCEEDED)),
      ...live.map((s) => ({
        ...step(s.id, McStepType.TALK, McStepStatus.PENDING),
        id: `${s.id}-talk`,
      })),
      step(null, McStepType.RENDER_REMOTION, McStepStatus.PENDING),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING),
    ];
    const ready = readySteps(f2(McProjectStatus.GENERATING), live, production);
    expect(ready.map((r) => r.type)).toEqual(Array(5).fill(McStepType.TALK));
  });

  it('todas as falas prontas → render_remotion; render concluído (mesma cadeia) → finalize; keyframe/assembly pendentes nunca saem', () => {
    const ready = scenes(5, McSceneStatus.READY);
    const steps = [
      ...ready.map((s) => ({
        ...step(s.id, McStepType.TALK, McStepStatus.SUCCEEDED),
        id: `${s.id}-talk`,
      })),
      // lixo que um bug poderia deixar: nunca deve ser agendado no F2
      step('s0', McStepType.KEYFRAME, McStepStatus.PENDING),
      step(null, McStepType.ASSEMBLY, McStepStatus.PENDING),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING),
      step(null, McStepType.RENDER_REMOTION, McStepStatus.PENDING),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING),
    ];
    const first = readySteps(f2(McProjectStatus.GENERATING), ready, steps);
    expect(first.map((r) => r.type)).toEqual([McStepType.RENDER_REMOTION]);
    const rendered = steps.map((s) =>
      s.type === McStepType.RENDER_REMOTION ? { ...s, status: McStepStatus.SUCCEEDED } : s,
    );
    expect(readySteps(f2(McProjectStatus.ASSEMBLING), ready, rendered).map((r) => r.type)).toEqual([
      McStepType.FINALIZE,
    ]);
    // render reaproveitado do cache (skipped_cached) também destrava o finalize
    const cached = steps.map((s) =>
      s.type === McStepType.RENDER_REMOTION ? { ...s, status: McStepStatus.SKIPPED_CACHED } : s,
    );
    expect(readySteps(f2(McProjectStatus.ASSEMBLING), ready, cached).map((r) => r.type)).toEqual([
      McStepType.FINALIZE,
    ]);
    // render de OUTRA entrega (attempt 1) não destrava o finalize da entrega nova (attempt 2)
    const nextDelivery = [
      ...steps.filter((s) => s.sceneId !== null),
      { ...step(null, McStepType.RENDER_REMOTION, McStepStatus.SUCCEEDED), attempt: 1 },
      { ...step(null, McStepType.RENDER_REMOTION, McStepStatus.PENDING), id: 'r2', attempt: 2 },
      { ...step(null, McStepType.FINALIZE, McStepStatus.PENDING), id: 'f2', attempt: 2 },
    ];
    expect(
      readySteps(f2(McProjectStatus.ASSEMBLING), ready, nextDelivery).map((r) => r.id),
    ).toEqual(['r2']);
  });
});
