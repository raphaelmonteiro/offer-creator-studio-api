import { isProjectAssemblyStep, projectAssemblySteps } from './mc-execution-plan';
import { mcQueueForStep } from './mc-pipeline.config';
import { MC_STEP_CREDITS, quotePhase } from './mc-pricing.config';
import { MC_PIPELINE_V2 } from './mc-quality';
import { readySteps, SchedulerScene, SchedulerStep } from './mc-scheduler';
import {
  canTransitionProject,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
} from './mc-state-machines';
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

const f1 = (status: McProjectStatus, revision = 1) => ({
  status,
  pipelineVersion: MC_PIPELINE_V2,
  revision,
  format: 'talking_art' as const,
});

describe('plano de projeto por formato (tarefa 4.3, D6)', () => {
  it('scenes → assembly; talking_art → compose_ffmpeg → finalize; ambos na fila mc.ffmpeg', () => {
    expect(projectAssemblySteps('scenes')).toEqual([McStepType.ASSEMBLY]);
    expect(projectAssemblySteps(undefined)).toEqual([McStepType.ASSEMBLY]);
    expect(projectAssemblySteps('talking_art')).toEqual([
      McStepType.COMPOSE_FFMPEG,
      McStepType.FINALIZE,
    ]);
    expect(mcQueueForStep(McStepType.COMPOSE_FFMPEG)).toBe(QUEUES.MC_FFMPEG);
    expect(mcQueueForStep(McStepType.FINALIZE)).toBe(QUEUES.MC_FFMPEG);
    expect(isProjectAssemblyStep(McStepType.COMPOSE_FFMPEG)).toBe(true);
    expect(isProjectAssemblyStep(McStepType.FINALIZE)).toBe(true);
    expect(isProjectAssemblyStep(McStepType.ASSEMBLY)).toBe(true);
    expect(isProjectAssemblyStep(McStepType.TALK)).toBe(false);
    expect(MC_STEP_CREDITS[McStepType.COMPOSE_FFMPEG]).toBe(0);
    expect(MC_STEP_CREDITS[McStepType.FINALIZE]).toBe(0);
  });

  it('cotação da produção F1 inclui compose_ffmpeg + finalize (nunca assembly); scenes mantém assembly', () => {
    const talk = quotePhase(
      'production',
      1,
      [{ sceneId: 's1', sceneType: 'talk_tile', cached: [] }],
      { format: 'talking_art' },
    );
    expect(talk.items.map((i) => i.stepType)).toEqual([
      McStepType.TALK,
      McStepType.COMPOSE_FFMPEG,
      McStepType.FINALIZE,
    ]);
    expect(talk.items.filter((i) => i.sceneId === null)).toHaveLength(2);
    const assembly = quotePhase('assembly', 1, [], { format: 'talking_art' });
    expect(assembly.items.map((i) => i.stepType)).toEqual([
      McStepType.COMPOSE_FFMPEG,
      McStepType.FINALIZE,
    ]);
    expect(quotePhase('production', 1, []).items.map((i) => i.stepType)).toEqual([
      McStepType.ASSEMBLY,
    ]);
  });
});

describe('mc-scheduler — projeto talking_art (tarefa 4.3)', () => {
  const scenes = [talkScene('s1', 0), talkScene('s2', 1), talkScene('s3', 2)];

  it('preparing agenda só tts; generating só talk (nunca keyframe/assembly)', () => {
    const steps = [
      ...scenes.map((s) => step(s.id, McStepType.TTS, McStepStatus.PENDING)),
      ...scenes.map((s) => step(s.id, McStepType.TALK, McStepStatus.PENDING)),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING),
    ];
    const preparing = readySteps(f1(McProjectStatus.PREPARING), scenes, steps);
    expect(preparing.map((r) => r.type)).toEqual([McStepType.TTS, McStepType.TTS, McStepType.TTS]);
    // tts concluído libera o talk na produção; compose espera os finais
    steps.forEach((s) => {
      if (s.type === McStepType.TTS) s.status = McStepStatus.SUCCEEDED;
    });
    const generating = readySteps(f1(McProjectStatus.GENERATING), scenes, steps);
    expect(generating.map((r) => r.type)).toEqual([
      McStepType.TALK,
      McStepType.TALK,
      McStepType.TALK,
    ]);
    expect(generating.some((r) => r.type === McStepType.KEYFRAME)).toBe(false);
    expect(generating.some((r) => r.type === McStepType.ASSEMBLY)).toBe(false);
  });

  it('todos os talk concluídos ⇒ compose_ffmpeg (e só ele); compose concluído ⇒ finalize', () => {
    const steps = [
      ...scenes.map((s) => step(s.id, McStepType.TTS, McStepStatus.SUCCEEDED)),
      ...scenes.map((s) => step(s.id, McStepType.TALK, McStepStatus.SUCCEEDED)),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING),
    ];
    const ready = readySteps(f1(McProjectStatus.GENERATING), scenes, steps);
    expect(ready.map((r) => r.type)).toEqual([McStepType.COMPOSE_FFMPEG]);
    expect(ready[0].sceneId).toBeNull();

    // um talk ainda pendente segura o compose
    steps[3].status = McStepStatus.PENDING;
    expect(readySteps(f1(McProjectStatus.GENERATING), scenes, steps).map((r) => r.type)).toEqual([
      McStepType.TALK,
    ]);
    steps[3].status = McStepStatus.SUCCEEDED;

    // compose concluído (em assembling) libera o finalize da MESMA cadeia
    steps[6].status = McStepStatus.SUCCEEDED;
    expect(readySteps(f1(McProjectStatus.ASSEMBLING), scenes, steps).map((r) => r.type)).toEqual([
      McStepType.FINALIZE,
    ]);
  });

  it('compose concluído de uma entrega ANTERIOR (attempt 1) não destrava o finalize da cadeia nova (attempt 2)', () => {
    const readyScenes = scenes.map((s) => ({ ...s, status: McSceneStatus.READY }));
    const steps = [
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.SUCCEEDED, { attempt: 1 }),
      step(null, McStepType.FINALIZE, McStepStatus.SUCCEEDED, { attempt: 1 }),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING, { attempt: 2 }),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING, { attempt: 2 }),
    ];
    const ready = readySteps(f1(McProjectStatus.ASSEMBLING), readyScenes, steps);
    expect(ready.map((r) => [r.type, r.id])).toEqual([
      [McStepType.COMPOSE_FFMPEG, 'proj-compose_ffmpeg-2'],
    ]);
  });

  it('assembly_only (correção sem regerar): cenas READY de revisão anterior + cadeia pendente da revisão nova ⇒ compose e depois finalize', () => {
    const readyScenes = scenes.map((s) => ({ ...s, status: McSceneStatus.READY }));
    const steps = [
      // talks da revisão 1 (já entregues) — não contam como candidatos da revisão 2
      ...scenes.map((s) =>
        step(s.id, McStepType.TALK, McStepStatus.SUCCEEDED, { projectRevision: 1 }),
      ),
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING, {
        projectRevision: 2,
        attempt: 2,
      }),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING, { projectRevision: 2, attempt: 2 }),
    ];
    const first = readySteps(f1(McProjectStatus.ASSEMBLING, 2), readyScenes, steps);
    expect(first.map((r) => r.type)).toEqual([McStepType.COMPOSE_FFMPEG]);
    steps[3].status = McStepStatus.SUCCEEDED;
    expect(
      readySteps(f1(McProjectStatus.ASSEMBLING, 2), readyScenes, steps).map((r) => r.type),
    ).toEqual([McStepType.FINALIZE]);
    // nada de talk novo numa remontagem
    expect(first.some((r) => r.type === McStepType.TALK)).toBe(false);
  });

  it('cadeia de revisão antiga nunca roda; visual_review não agenda nada', () => {
    const readyScenes = scenes.map((s) => ({ ...s, status: McSceneStatus.READY }));
    const steps = [
      step(null, McStepType.COMPOSE_FFMPEG, McStepStatus.PENDING, { projectRevision: 1 }),
      step(null, McStepType.FINALIZE, McStepStatus.PENDING, { projectRevision: 1 }),
    ];
    expect(readySteps(f1(McProjectStatus.ASSEMBLING, 2), readyScenes, steps)).toEqual([]);
    expect(readySteps(f1(McProjectStatus.VISUAL_REVIEW, 1), readyScenes, steps)).toEqual([]);
  });

  it('caminho de estados do F1 é o do v2, sem estados novos', () => {
    const path = [
      McProjectStatus.SCRIPTING,
      McProjectStatus.STORYBOARD_REVIEW,
      McProjectStatus.PREPARING,
      McProjectStatus.VISUAL_REVIEW,
      McProjectStatus.GENERATING,
      McProjectStatus.ASSEMBLING,
      McProjectStatus.SUCCEEDED,
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransitionProject(path[i], path[i + 1])).toBe(true);
    }
    // correções sem regerar: visual_review → assembling (assembly_only) e succeeded → visual_review
    expect(canTransitionProject(McProjectStatus.VISUAL_REVIEW, McProjectStatus.ASSEMBLING)).toBe(
      true,
    );
    expect(canTransitionProject(McProjectStatus.SUCCEEDED, McProjectStatus.VISUAL_REVIEW)).toBe(
      true,
    );
    // falha da composição retoma a montagem a partir de needs_attention
    expect(canTransitionProject(McProjectStatus.NEEDS_ATTENTION, McProjectStatus.ASSEMBLING)).toBe(
      true,
    );
  });
});
