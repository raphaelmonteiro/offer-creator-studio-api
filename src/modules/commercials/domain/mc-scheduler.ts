import {
  DONE_STEP_STATUSES,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
} from './mc-state-machines';
import { McStepType } from './mc-types';

/**
 * Scheduler do grafo de dependências (plano-comerciais §6.2) — FUNÇÃO PURA:
 * `(project, scenes, steps) → steps desbloqueados`. É chamada na transação que
 * conclui cada step; o chamador enfileira os retornados na MESMA transação
 * (pg-boss é Postgres — atomicidade real) e faz o CAS pending → queued.
 *
 * Topologia FIXA, parametrizada pelo nº de cenas:
 *
 *   script (LLM) ─► [GATE humano: storyboard_review] ─► por cena i:
 *                       keyframe(i) ─► video(i) ──┐
 *                       tts(i) [se dialogue] ─────┤─► lipsync(i) [se dialogue]
 *                                                 └─► final da cena
 *   todas as cenas com final pronto ─► assembly (ffmpeg) ─► final
 *
 * Regras:
 * - `script` roda com o projeto em `scripting`; steps de cena só em
 *   `generating` (precisam do GATE aprovado); `assembly` em
 *   `generating`/`assembling` (robusto à ordem transição × agendamento).
 * - Cena muda (dialogue null) não tem tts/lipsync — o `video` é o final dela.
 * - `skipped_cached` conta como succeeded para dependências (§6.3): no re-roll
 *   (generation++) o planner recria keyframe/tts como skipped_cached e só o
 *   video (+lipsync) roda de novo.
 * - Steps de gerações antigas (sceneGeneration ≠ scene.generation) são
 *   ignorados por completo — nem candidatos, nem dependências.
 * - `needs_attention` não agenda nada novo (pausa para ação humana, §6.4);
 *   o re-roll da cena devolve o projeto a `generating`.
 */

export interface SchedulerProject {
  status: McProjectStatus;
}

export interface SchedulerScene {
  id: string;
  idx: number;
  generation: number;
  status: McSceneStatus;
  dialogue: string | null;
}

export interface SchedulerStep {
  id: string;
  sceneId: string | null;
  sceneGeneration: number | null;
  type: McStepType;
  status: McStepStatus;
}

export interface StepRef {
  id: string;
  type: McStepType;
  sceneId: string | null;
}

function isDone(step: SchedulerStep | undefined): boolean {
  return !!step && DONE_STEP_STATUSES.includes(step.status);
}

function toRef(step: SchedulerStep): StepRef {
  return { id: step.id, type: step.type, sceneId: step.sceneId };
}

/** Steps da geração corrente de uma cena, indexados por tipo. */
function currentGenerationSteps(
  scene: SchedulerScene,
  steps: SchedulerStep[],
): Partial<Record<McStepType, SchedulerStep>> {
  const byType: Partial<Record<McStepType, SchedulerStep>> = {};
  for (const step of steps) {
    if (step.sceneId === scene.id && step.sceneGeneration === scene.generation) {
      byType[step.type] = step;
    }
  }
  return byType;
}

/** Tipo do step que finaliza a cena: falada termina no lipsync, muda no video. */
export function sceneFinalStepType(scene: Pick<SchedulerScene, 'dialogue'>): McStepType {
  const spoken = scene.dialogue !== null && scene.dialogue !== undefined && scene.dialogue !== '';
  return spoken ? McStepType.LIPSYNC : McStepType.VIDEO;
}

export function readySteps(
  project: SchedulerProject,
  scenes: SchedulerScene[],
  steps: SchedulerStep[],
): StepRef[] {
  const ready: StepRef[] = [];

  // Fase de roteiro: só o step 'script' (nível de projeto) roda.
  if (project.status === McProjectStatus.SCRIPTING) {
    for (const step of steps) {
      if (
        step.type === McStepType.SCRIPT &&
        step.sceneId === null &&
        step.status === McStepStatus.PENDING
      ) {
        ready.push(toRef(step));
      }
    }
    return ready;
  }

  const generating = project.status === McProjectStatus.GENERATING;
  const assembling = project.status === McProjectStatus.ASSEMBLING;
  if (!generating && !assembling) return ready; // draft/review/needs_attention/terminais: nada

  // Steps por cena — apenas com o GATE aprovado (generating) e em cenas vivas.
  if (generating) {
    for (const scene of scenes) {
      if (scene.status !== McSceneStatus.PENDING && scene.status !== McSceneStatus.RUNNING) {
        continue; // ready não tem pendência; failed/canceled esperam re-roll/nada
      }
      const byType = currentGenerationSteps(scene, steps);
      const spoken = sceneFinalStepType(scene) === McStepType.LIPSYNC;

      const keyframe = byType[McStepType.KEYFRAME];
      if (keyframe?.status === McStepStatus.PENDING) ready.push(toRef(keyframe));

      // tts em paralelo desde o início (não depende do keyframe/video)
      const tts = byType[McStepType.TTS];
      if (spoken && tts?.status === McStepStatus.PENDING) ready.push(toRef(tts));

      const video = byType[McStepType.VIDEO];
      if (video?.status === McStepStatus.PENDING && isDone(keyframe)) ready.push(toRef(video));

      const lipsync = byType[McStepType.LIPSYNC];
      // lipsync depende do keyframe DIRETAMENTE, não só via video: no fluxo
      // audio-driven o step `video` nasce skipped_cached e a cadeia
      // keyframe→video colapsaria — com TTS real (2s) terminando antes do
      // keyframe (~15s), o Avatar seria submetido sem imagem (bug pego na
      // primeira produção real; o mock nunca expôs porque keyframe mock é
      // instantâneo).
      if (
        spoken &&
        lipsync?.status === McStepStatus.PENDING &&
        isDone(keyframe) &&
        isDone(video) &&
        isDone(tts)
      ) {
        ready.push(toRef(lipsync));
      }
    }
  }

  // Assembly: TODAS as cenas não-canceladas da geração corrente com final pronto.
  const assembly = steps.find(
    (s) =>
      s.type === McStepType.ASSEMBLY && s.sceneId === null && s.status === McStepStatus.PENDING,
  );
  if (assembly) {
    const liveScenes = scenes.filter((s) => s.status !== McSceneStatus.CANCELED);
    const allFinalsDone =
      liveScenes.length > 0 &&
      liveScenes.every((scene) =>
        isDone(currentGenerationSteps(scene, steps)[sceneFinalStepType(scene)]),
      );
    if (allFinalsDone) ready.push(toRef(assembly));
  }

  return ready;
}
