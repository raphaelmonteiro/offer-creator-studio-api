import {
  firstSceneDependentAssemblyStep,
  isProjectAssemblyStep,
  isSceneIndependentProjectStep,
  projectAssemblySteps,
} from './mc-execution-plan';
import { mcQueueForStep } from './mc-pipeline.config';
import { MC_STEP_CREDITS, quotePhase } from './mc-pricing.config';
import { MC_PIPELINE_V2 } from './mc-quality';
import { readySteps, SchedulerScene, SchedulerStep } from './mc-scheduler';
import { McProjectStatus, McSceneStatus, McStepStatus } from './mc-state-machines';
import { McStepType } from './mc-types';
import { QUEUES } from '../../../shared/queue/animation-queue.service';

function talkScene(id: string, idx: number, status = McSceneStatus.PENDING): SchedulerScene {
  return { id, idx, generation: 1, status, dialogue: 'fala', sceneType: 'talk_tile' };
}

function step(
  sceneId: string | null,
  type: McStepType,
  status: McStepStatus,
  extra: Partial<SchedulerStep> = {},
): SchedulerStep {
  return {
    id: `${sceneId ?? 'proj'}-${type}-${extra.attempt ?? 1}`,
    sceneId,
    sceneGeneration: sceneId ? 1 : null,
    type,
    status,
    projectRevision: 1,
    attempt: 1,
    ...extra,
  };
}

const piece = (status: McProjectStatus, revision = 1) => ({
  status,
  pipelineVersion: MC_PIPELINE_V2,
  revision,
  format: 'offer_piece' as const,
});

const types = (refs: { type: McStepType }[]) => refs.map((r) => r.type);

describe('plano de projeto da peça de ofertas (change video-peca-configuravel, 6.1/6.3/6.7)', () => {
  it('offer_piece → render_still → compose_ffmpeg → finalize; o quadro vai para mc.render e custa 0', () => {
    expect(projectAssemblySteps('offer_piece')).toEqual([
      McStepType.RENDER_STILL,
      McStepType.COMPOSE_FFMPEG,
      McStepType.FINALIZE,
    ]);
    expect(mcQueueForStep(McStepType.RENDER_STILL)).toBe(QUEUES.MC_RENDER);
    expect(MC_STEP_CREDITS[McStepType.RENDER_STILL]).toBe(0);
    expect(isProjectAssemblyStep(McStepType.RENDER_STILL)).toBe(true);
    expect(isSceneIndependentProjectStep(McStepType.RENDER_STILL)).toBe(true);
    expect(isSceneIndependentProjectStep(McStepType.COMPOSE_FFMPEG)).toBe(false);
    expect(isSceneIndependentProjectStep(McStepType.RENDER_REMOTION)).toBe(false);
  });

  it('o step que marca a entrada em montagem é o primeiro que precisa das cenas: compose na peça, compose no F1, render no F2, assembly no F3', () => {
    expect(firstSceneDependentAssemblyStep('offer_piece')).toBe(McStepType.COMPOSE_FFMPEG);
    expect(firstSceneDependentAssemblyStep('talking_art')).toBe(McStepType.COMPOSE_FFMPEG);
    expect(firstSceneDependentAssemblyStep('offer_carousel')).toBe(McStepType.RENDER_REMOTION);
    expect(firstSceneDependentAssemblyStep('scenes')).toBe(McStepType.ASSEMBLY);
    expect(firstSceneDependentAssemblyStep(undefined)).toBe(McStepType.ASSEMBLY);
  });

  it('cotação: tts/talk por fala como no F2 + render_still (0) + compose + finalize; remontagem só a cadeia', () => {
    const production = quotePhase(
      'production',
      1,
      [
        { sceneId: 's1', sceneType: 'talk_tile', cached: [] },
        { sceneId: 's2', sceneType: 'talk_tile', cached: [] },
      ],
      { format: 'offer_piece' },
    );
    expect(production.items.map((i) => i.stepType)).toEqual([
      McStepType.TALK,
      McStepType.TALK,
      McStepType.RENDER_STILL,
      McStepType.COMPOSE_FFMPEG,
      McStepType.FINALIZE,
    ]);
    expect(production.items.find((i) => i.stepType === McStepType.RENDER_STILL)).toMatchObject({
      sceneId: null,
      credits: 0,
      cached: false,
    });
    expect(production.totalCredits).toBe(2 * MC_STEP_CREDITS[McStepType.TALK]);
    expect(
      quotePhase('assembly', 1, [], { format: 'offer_piece' }).items.map((i) => i.stepType),
    ).toEqual([McStepType.RENDER_STILL, McStepType.COMPOSE_FFMPEG, McStepType.FINALIZE]);
  });
});

describe('mc-scheduler — projeto offer_piece (6.3)', () => {
  const scenes = [talkScene('s1', 0), talkScene('s2', 1), talkScene('s3', 2)];
  const chain = () => [
    step(null, McStepType.RENDER_STILL, McStepStatus.PENDING),
    step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING),
    step(null, McStepType.FINALIZE, McStepStatus.PENDING),
  ];

  it('render_still libera assim que existe pendente — junto dos talk, enquanto as falas gravam', () => {
    const steps = [
      ...scenes.map((s) => step(s.id, McStepType.TTS, McStepStatus.SUCCEEDED)),
      ...scenes.map((s) => step(s.id, McStepType.TALK, McStepStatus.PENDING)),
      ...chain(),
    ];
    const ready = readySteps(piece(McProjectStatus.GENERATING), scenes, steps);
    expect(types(ready)).toEqual([
      McStepType.TALK,
      McStepType.TALK,
      McStepType.TALK,
      McStepType.RENDER_STILL,
    ]);
    expect(ready.find((r) => r.type === McStepType.RENDER_STILL)?.sceneId).toBeNull();
    // em preparing o quadro ainda não roda (a cadeia só é materializada na aprovação da produção)
    expect(
      types(readySteps(piece(McProjectStatus.PREPARING), scenes, steps)).includes(
        McStepType.RENDER_STILL,
      ),
    ).toBe(false);
  });

  it('compose espera o quadro E todas as cenas: falas prontas sem quadro ⇒ só render_still; quadro pronto com fala pendente ⇒ só o talk', () => {
    const steps = [
      ...scenes.map((s) => step(s.id, McStepType.TTS, McStepStatus.SUCCEEDED)),
      ...scenes.map((s) => step(s.id, McStepType.TALK, McStepStatus.SUCCEEDED)),
      ...chain(),
    ];
    expect(types(readySteps(piece(McProjectStatus.GENERATING), scenes, steps))).toEqual([
      McStepType.RENDER_STILL,
    ]);

    // quadro pronto, uma fala ainda gravando → compose segura, nada de finalize
    steps[6].status = McStepStatus.SUCCEEDED;
    steps[3].status = McStepStatus.PENDING;
    expect(types(readySteps(piece(McProjectStatus.GENERATING), scenes, steps))).toEqual([
      McStepType.TALK,
    ]);

    // tudo pronto → compose (e só ele)
    steps[3].status = McStepStatus.SUCCEEDED;
    const ready = readySteps(piece(McProjectStatus.GENERATING), scenes, steps);
    expect(types(ready)).toEqual([McStepType.COMPOSE_FFMPEG]);

    // compose concluído (em assembling) libera o finalize da MESMA cadeia
    steps[7].status = McStepStatus.SUCCEEDED;
    expect(types(readySteps(piece(McProjectStatus.ASSEMBLING), scenes, steps))).toEqual([
      McStepType.FINALIZE,
    ]);
  });

  it('quadro reaproveitado por cache (skipped_cached) conta como pronto para o compose', () => {
    const readyScenes = scenes.map((s) => ({ ...s, status: McSceneStatus.READY }));
    const steps = [
      step(null, McStepType.RENDER_STILL, McStepStatus.SKIPPED_CACHED),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING),
    ];
    expect(types(readySteps(piece(McProjectStatus.GENERATING), readyScenes, steps))).toEqual([
      McStepType.COMPOSE_FFMPEG,
    ]);
  });

  it('quadro de uma entrega ANTERIOR (attempt 1) não destrava o compose da cadeia nova (attempt 2)', () => {
    const readyScenes = scenes.map((s) => ({ ...s, status: McSceneStatus.READY }));
    const steps = [
      step(null, McStepType.RENDER_STILL, McStepStatus.SUCCEEDED, { attempt: 1 }),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.SUCCEEDED, { attempt: 1 }),
      step(null, McStepType.FINALIZE, McStepStatus.SUCCEEDED, { attempt: 1 }),
      step(null, McStepType.RENDER_STILL, McStepStatus.PENDING, { attempt: 2 }),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING, { attempt: 2 }),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING, { attempt: 2 }),
    ];
    // a cadeia nova começa pelo quadro novo; o compose só depois do quadro DELA
    expect(types(readySteps(piece(McProjectStatus.ASSEMBLING), readyScenes, steps))).toEqual([
      McStepType.RENDER_STILL,
    ]);
    steps[3].status = McStepStatus.SUCCEEDED;
    expect(types(readySteps(piece(McProjectStatus.ASSEMBLING), readyScenes, steps))).toEqual([
      McStepType.COMPOSE_FFMPEG,
    ]);
  });
});
