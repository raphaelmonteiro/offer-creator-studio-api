import { MC_PIPELINE_V2 } from './mc-quality';
import {
  preparationComplete,
  readySteps,
  sceneFinalStepType,
  SchedulerScene,
  SchedulerStep,
} from './mc-scheduler';
import { McProjectStatus, McSceneStatus, McStepStatus } from './mc-state-machines';
import { McSceneType, McStepType } from './mc-types';

function scene(id: string, sceneType: McSceneType, status = McSceneStatus.PENDING): SchedulerScene {
  return {
    id,
    idx: Number(id.replace(/\D/g, '')) || 0,
    generation: 1,
    status,
    dialogue: sceneType === 'action' ? null : 'fala',
    sceneType,
  };
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

const v2 = (status: McProjectStatus, revision = 1) => ({
  status,
  pipelineVersion: MC_PIPELINE_V2,
  revision,
});

describe('mc-scheduler — pipeline v2 (ADR §4.1/§4.2)', () => {
  it('sceneFinalStepType usa o plano quando há tipo: voiceover termina no scene_compose', () => {
    expect(sceneFinalStepType({ dialogue: 'x', sceneType: 'action_voiceover' })).toBe(
      McStepType.SCENE_COMPOSE,
    );
    expect(sceneFinalStepType({ dialogue: 'x', sceneType: 'presenter' })).toBe(McStepType.LIPSYNC);
    expect(sceneFinalStepType({ dialogue: null, sceneType: 'action' })).toBe(McStepType.VIDEO);
    // legado: por diálogo
    expect(sceneFinalStepType({ dialogue: 'x' })).toBe(McStepType.LIPSYNC);
    expect(sceneFinalStepType({ dialogue: null })).toBe(McStepType.VIDEO);
  });

  it('preparing: agenda SÓ keyframe/tts do plano; nunca vídeo', () => {
    const scenes = [
      scene('s1', 'presenter'),
      scene('s2', 'action_voiceover'),
      scene('s3', 'action'),
    ];
    const steps = [
      step('s1', McStepType.KEYFRAME, McStepStatus.PENDING),
      step('s1', McStepType.TTS, McStepStatus.PENDING),
      step('s2', McStepType.KEYFRAME, McStepStatus.PENDING),
      step('s2', McStepType.TTS, McStepStatus.PENDING),
      step('s3', McStepType.KEYFRAME, McStepStatus.PENDING),
      // vídeo pendente por engano — não pode sair em preparing
      step('s3', McStepType.VIDEO, McStepStatus.PENDING),
    ];
    const ready = readySteps(v2(McProjectStatus.PREPARING), scenes, steps);
    expect(ready.map((r) => r.type).sort()).toEqual(
      [
        McStepType.KEYFRAME,
        McStepType.KEYFRAME,
        McStepType.KEYFRAME,
        McStepType.TTS,
        McStepType.TTS,
      ].sort(),
    );
    expect(ready.some((r) => r.type === McStepType.VIDEO)).toBe(false);
  });

  it('visual_review e storyboard_review não agendam nada', () => {
    const scenes = [scene('s3', 'action')];
    const steps = [step('s3', McStepType.VIDEO, McStepStatus.PENDING)];
    expect(readySteps(v2(McProjectStatus.VISUAL_REVIEW), scenes, steps)).toEqual([]);
    expect(readySteps(v2(McProjectStatus.STORYBOARD_REVIEW), scenes, steps)).toEqual([]);
    expect(readySteps(v2(McProjectStatus.NEEDS_ATTENTION), scenes, steps)).toEqual([]);
  });

  it('generating: produção respeita dependências do plano por tipo', () => {
    const scenes = [scene('s1', 'presenter'), scene('s2', 'action_voiceover')];
    const steps = [
      step('s1', McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
      step('s1', McStepType.TTS, McStepStatus.SKIPPED_CACHED),
      step('s1', McStepType.LIPSYNC, McStepStatus.PENDING),
      step('s2', McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
      step('s2', McStepType.TTS, McStepStatus.SUCCEEDED),
      step('s2', McStepType.VIDEO, McStepStatus.PENDING),
      step('s2', McStepType.SCENE_COMPOSE, McStepStatus.PENDING),
    ];
    const ready = readySteps(v2(McProjectStatus.GENERATING), scenes, steps);
    expect(ready.map((r) => r.type).sort()).toEqual([McStepType.LIPSYNC, McStepType.VIDEO].sort());
    // scene_compose só depois do vídeo
    steps[5].status = McStepStatus.SUCCEEDED;
    const after = readySteps(v2(McProjectStatus.GENERATING), scenes, steps);
    expect(after.map((r) => r.type)).toEqual([McStepType.LIPSYNC, McStepType.SCENE_COMPOSE]);
  });

  it('presenter não depende de video (não existe step video no plano) — voiceover nunca tem lipsync', () => {
    const scenes = [scene('s1', 'presenter')];
    const steps = [
      step('s1', McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
      step('s1', McStepType.TTS, McStepStatus.SUCCEEDED),
      step('s1', McStepType.LIPSYNC, McStepStatus.PENDING),
    ];
    expect(readySteps(v2(McProjectStatus.GENERATING), scenes, steps).map((r) => r.type)).toEqual([
      McStepType.LIPSYNC,
    ]);
  });

  it('steps de revisão antiga são ignorados (aprovação antiga não autoriza gasto)', () => {
    const scenes = [scene('s3', 'action')];
    const steps = [
      step('s3', McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
      step('s3', McStepType.VIDEO, McStepStatus.PENDING, { projectRevision: 1 }),
    ];
    expect(readySteps(v2(McProjectStatus.GENERATING, 2), scenes, steps)).toEqual([]);
  });

  it('tentativas: a mais recente representa o tipo (regenerar prévia)', () => {
    const scenes = [scene('s3', 'action')];
    const steps = [
      step('s3', McStepType.KEYFRAME, McStepStatus.SUCCEEDED, { attempt: 1 }),
      step('s3', McStepType.KEYFRAME, McStepStatus.PENDING, { attempt: 2 }),
    ];
    const ready = readySteps(v2(McProjectStatus.PREPARING), scenes, steps);
    expect(ready.map((r) => r.id)).toEqual(['s3-keyframe-2']);
    expect(preparationComplete({ revision: 1 }, scenes, steps)).toBe(false);
    steps[1].status = McStepStatus.SUCCEEDED;
    expect(preparationComplete({ revision: 1 }, scenes, steps)).toBe(true);
  });

  it('preparationComplete: cache integral conta como concluído; cena cancelada não bloqueia', () => {
    const scenes = [scene('s1', 'presenter'), scene('s2', 'action', McSceneStatus.CANCELED)];
    const steps = [
      step('s1', McStepType.KEYFRAME, McStepStatus.SKIPPED_CACHED),
      step('s1', McStepType.TTS, McStepStatus.SKIPPED_CACHED),
    ];
    expect(preparationComplete({ revision: 1 }, scenes, steps)).toBe(true);
    expect(preparationComplete({ revision: 1 }, [], steps)).toBe(false);
  });

  it('assembly só com TODOS os finais do plano prontos (voiceover exige scene_compose, não só video)', () => {
    const scenes = [
      scene('s2', 'action_voiceover', McSceneStatus.RUNNING),
      scene('s3', 'action', McSceneStatus.READY),
    ];
    const steps = [
      step('s2', McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
      step('s2', McStepType.TTS, McStepStatus.SUCCEEDED),
      step('s2', McStepType.VIDEO, McStepStatus.SUCCEEDED),
      step('s2', McStepType.SCENE_COMPOSE, McStepStatus.RUNNING),
      step('s3', McStepType.KEYFRAME, McStepStatus.SUCCEEDED),
      step('s3', McStepType.VIDEO, McStepStatus.SUCCEEDED),
      step(null, McStepType.ASSEMBLY, McStepStatus.PENDING),
    ];
    expect(readySteps(v2(McProjectStatus.GENERATING), scenes, steps)).toEqual([]);
    steps[3].status = McStepStatus.SUCCEEDED;
    expect(readySteps(v2(McProjectStatus.GENERATING), scenes, steps).map((r) => r.type)).toEqual([
      McStepType.ASSEMBLY,
    ]);
    // assembling: também agenda o assembly (robusto à ordem transição × agendamento)
    expect(readySteps(v2(McProjectStatus.ASSEMBLING), scenes, steps).map((r) => r.type)).toEqual([
      McStepType.ASSEMBLY,
    ]);
  });

  it('assembly_only: cenas READY da revisão anterior liberam a montagem da revisão nova (sem steps de produção novos)', () => {
    const scenes = [
      scene('s1', 'presenter', McSceneStatus.READY),
      scene('s2', 'action', McSceneStatus.READY),
    ];
    const steps = [
      step('s1', McStepType.LIPSYNC, McStepStatus.SUCCEEDED, { projectRevision: 0 }),
      step('s2', McStepType.VIDEO, McStepStatus.SUCCEEDED, { projectRevision: 0 }),
      step(null, McStepType.ASSEMBLY, McStepStatus.PENDING, { projectRevision: 1 }),
    ];
    expect(readySteps(v2(McProjectStatus.ASSEMBLING, 1), scenes, steps).map((r) => r.type)).toEqual(
      [McStepType.ASSEMBLY],
    );
    // cena ainda pendente (re-roll em curso) segura a montagem
    scenes[1].status = McSceneStatus.PENDING;
    expect(readySteps(v2(McProjectStatus.ASSEMBLING, 1), scenes, steps)).toEqual([]);
  });

  it('re-roll após assembly_only: vídeo da revisão nova depende do keyframe aprovado na revisão anterior', () => {
    const scenes = [scene('s3', 'action')];
    const steps = [
      step('s3', McStepType.KEYFRAME, McStepStatus.SUCCEEDED, { projectRevision: 0 }),
      step('s3', McStepType.VIDEO, McStepStatus.SUCCEEDED, { projectRevision: 0, attempt: 1 }),
      step('s3', McStepType.VIDEO, McStepStatus.PENDING, { projectRevision: 1, attempt: 2 }),
    ];
    expect(readySteps(v2(McProjectStatus.GENERATING, 1), scenes, steps).map((r) => r.id)).toEqual([
      's3-video-2',
    ]);
    // prévia refeita na revisão nova ainda pendente bloqueia o vídeo
    steps.push(
      step('s3', McStepType.KEYFRAME, McStepStatus.PENDING, { projectRevision: 1, attempt: 2 }),
    );
    expect(readySteps(v2(McProjectStatus.GENERATING, 1), scenes, steps)).toEqual([]);
  });

  it('projeto legado (sem pipelineVersion 2) continua no grafo por diálogo', () => {
    const scenes: SchedulerScene[] = [
      { id: 's1', idx: 0, generation: 1, status: McSceneStatus.PENDING, dialogue: 'x' },
    ];
    const steps = [
      step('s1', McStepType.KEYFRAME, McStepStatus.SUCCEEDED, { projectRevision: null }),
      step('s1', McStepType.TTS, McStepStatus.SUCCEEDED, { projectRevision: null }),
      step('s1', McStepType.VIDEO, McStepStatus.SKIPPED_CACHED, { projectRevision: null }),
      step('s1', McStepType.LIPSYNC, McStepStatus.PENDING, { projectRevision: null }),
    ];
    const ready = readySteps(
      { status: McProjectStatus.GENERATING, pipelineVersion: 1 },
      scenes,
      steps,
    );
    expect(ready.map((r) => r.type)).toEqual([McStepType.LIPSYNC]);
    // e em preparing (estado que o legado nunca usa) não agenda nada
    expect(
      readySteps({ status: McProjectStatus.PREPARING, pipelineVersion: 1 }, scenes, steps),
    ).toEqual([]);
  });
});
