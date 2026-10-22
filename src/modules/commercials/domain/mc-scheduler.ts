import {
  isSceneIndependentProjectStep,
  planSteps,
  projectAssemblySteps,
  scenePlan,
} from './mc-execution-plan';
import { isPipelineV2 } from './mc-quality';
import {
  DONE_STEP_STATUSES,
  McProjectStatus,
  McSceneStatus,
  McStepStatus,
} from './mc-state-machines';
import { McProjectFormat, McSceneType, McStepType } from './mc-types';

/**
 * Scheduler do grafo de dependências (plano-comerciais §6.2) — FUNÇÃO PURA:
 * `(project, scenes, steps) → steps desbloqueados`. É chamada na transação que
 * conclui cada step; o chamador enfileira os retornados na MESMA transação
 * (pg-boss é Postgres — atomicidade real) e faz o CAS pending → queued.
 *
 * LEGADO (pipelineVersion 1) — topologia FIXA, parametrizada pelo nº de cenas:
 *
 *   script (LLM) ─► [GATE humano: storyboard_review] ─► por cena i:
 *                       keyframe(i) ─► video(i) ──┐
 *                       tts(i) [se dialogue] ─────┤─► lipsync(i) [se dialogue]
 *                                                 └─► final da cena
 *   todas as cenas com final pronto ─► assembly (ffmpeg) ─► final
 *
 * PIPELINE V2 (ADR-001 §4.1/§4.2) — grafo por TIPO DE CENA (mc-execution-plan):
 *
 *   script ─► storyboard_review ─► [preparar] ─► preparing: keyframe/tts
 *           ─► visual_review (nada agenda vídeo) ─► [aprovar] ─► generating:
 *           produção do plano (video | lipsync | video→scene_compose)
 *           ─► assembling: assembly quando todos os finais estão prontos.
 *
 * Regras comuns:
 * - `skipped_cached` conta como succeeded para dependências (§6.3).
 * - Steps de gerações antigas (sceneGeneration ≠ scene.generation) são
 *   ignorados por completo — nem candidatos, nem dependências.
 * - `needs_attention` não agenda nada novo (pausa para ação humana, §6.4).
 * Regras só do v2:
 * - Steps de outra REVISÃO (projectRevision ≠ project.revision) são ignorados:
 *   aprovação antiga nunca autoriza gasto novo (ADR §4.1).
 * - Várias TENTATIVAS do mesmo tipo convivem na geração corrente (regenerar
 *   prévia): a mais recente (maior `attempt`) representa o tipo.
 */

export interface SchedulerProject {
  status: McProjectStatus;
  pipelineVersion?: number | null;
  revision?: number | null;
  /** Formato (D6): escolhe a cadeia de steps de projeto da fase assembly; ausente = `scenes`. */
  format?: McProjectFormat | null;
}

export interface SchedulerScene {
  id: string;
  idx: number;
  generation: number;
  status: McSceneStatus;
  dialogue: string | null;
  sceneType?: McSceneType | null;
}

export interface SchedulerStep {
  id: string;
  sceneId: string | null;
  sceneGeneration: number | null;
  type: McStepType;
  status: McStepStatus;
  projectRevision?: number | null;
  attempt?: number | null;
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

/** Steps da geração corrente de uma cena, indexados por tipo (v2: tentativa mais recente vence). */
export function currentGenerationSteps(
  scene: SchedulerScene,
  steps: SchedulerStep[],
  revision?: number | null,
): Partial<Record<McStepType, SchedulerStep>> {
  const byType: Partial<Record<McStepType, SchedulerStep>> = {};
  for (const step of steps) {
    if (step.sceneId !== scene.id || step.sceneGeneration !== scene.generation) continue;
    if (revision != null && step.projectRevision != null && step.projectRevision !== revision) {
      continue;
    }
    const current = byType[step.type];
    if (!current || (step.attempt ?? 1) >= (current.attempt ?? 1)) byType[step.type] = step;
  }
  return byType;
}

/**
 * Tipo do step que finaliza a cena: legado — falada termina no lipsync, muda
 * no video; v2 — o `final` do plano do tipo de cena (voiceover termina no
 * scene_compose, nunca no video).
 */
export function sceneFinalStepType(
  scene: Pick<SchedulerScene, 'dialogue'> & { sceneType?: McSceneType | null },
): McStepType {
  if (scene.sceneType) return scenePlan(scene.sceneType).final;
  const spoken = scene.dialogue !== null && scene.dialogue !== undefined && scene.dialogue !== '';
  return spoken ? McStepType.LIPSYNC : McStepType.VIDEO;
}

export function readySteps(
  project: SchedulerProject,
  scenes: SchedulerScene[],
  steps: SchedulerStep[],
): StepRef[] {
  if (isPipelineV2(project)) return readyStepsV2(project, scenes, steps);
  return readyStepsLegacy(project, scenes, steps);
}

function scriptStepRefs(steps: SchedulerStep[]): StepRef[] {
  return steps
    .filter(
      (s) =>
        s.type === McStepType.SCRIPT && s.sceneId === null && s.status === McStepStatus.PENDING,
    )
    .map(toRef);
}

function readyStepsLegacy(
  project: SchedulerProject,
  scenes: SchedulerScene[],
  steps: SchedulerStep[],
): StepRef[] {
  const ready: StepRef[] = [];

  // Fase de roteiro: só o step 'script' (nível de projeto) roda.
  if (project.status === McProjectStatus.SCRIPTING) return scriptStepRefs(steps);

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

function sceneTypeOf(scene: SchedulerScene): McSceneType {
  if (scene.sceneType) return scene.sceneType;
  const spoken = scene.dialogue !== null && scene.dialogue !== undefined && scene.dialogue !== '';
  return spoken ? 'presenter' : 'action';
}

function readyStepsV2(
  project: SchedulerProject,
  scenes: SchedulerScene[],
  steps: SchedulerStep[],
): StepRef[] {
  const ready: StepRef[] = [];
  if (project.status === McProjectStatus.SCRIPTING) return scriptStepRefs(steps);

  const preparing = project.status === McProjectStatus.PREPARING;
  const generating = project.status === McProjectStatus.GENERATING;
  const assembling = project.status === McProjectStatus.ASSEMBLING;
  if (!preparing && !generating && !assembling) return ready;
  const revision = project.revision ?? null;

  for (const scene of scenes) {
    if (scene.status === McSceneStatus.CANCELED) continue;
    const plan = scenePlan(sceneTypeOf(scene));
    // CANDIDATOS: só steps da revisão corrente (aprovação antiga não roda).
    const byType = currentGenerationSteps(scene, steps, revision);
    // DEPENDÊNCIAS: a tentativa mais recente da geração, de QUALQUER revisão —
    // prévias/vídeos aprovados em revisões anteriores continuam válidos (a
    // seleção vive na cena) e são a base de re-rolls e revisões `assembly_only`.
    // Uma prévia refeita na revisão nova entra como tentativa mais recente e,
    // enquanto pendente, bloqueia os dependentes.
    const depsByType = currentGenerationSteps(scene, steps);
    // preparing: só imagem/TTS; generating: só produção; assembling: nada por cena.
    const candidates = preparing ? plan.preparation : generating ? plan.production : [];
    for (const type of candidates) {
      const step = byType[type];
      if (!step || step.status !== McStepStatus.PENDING) continue;
      if (step.projectRevision != null && revision != null && step.projectRevision !== revision) {
        continue;
      }
      const deps = plan.deps[type] ?? [];
      if (deps.every((dep) => isDone(depsByType[dep]))) ready.push(toRef(step));
    }
  }

  if (generating || assembling) {
    // Steps de PROJETO da fase assembly, por formato (D6): `assembly` (F3) ou
    // `compose_ffmpeg → finalize` (F1). O PRIMEIRO da cadeia destrava quando
    // todas as cenas vivas têm final; cada seguinte, quando o anterior (da
    // mesma revisão) concluiu. Nunca keyframe/assembly num projeto F1.
    const chain = projectAssemblySteps(project.format);
    const projectStep = (type: McStepType, status: McStepStatus, attempt?: number) =>
      steps.find(
        (s) =>
          s.type === type &&
          s.sceneId === null &&
          s.status === status &&
          (attempt == null || (s.attempt ?? 1) === attempt) &&
          (s.projectRevision == null || revision == null || s.projectRevision === revision),
      );
    // Cena `ready` já tem o clipe final (finalAssetId) — inclusive de uma
    // revisão ANTERIOR: a remontagem `assembly_only` reutiliza os clipes
    // aprovados sem novos steps de produção (ADR §4.1), então a prontidão
    // não pode depender de steps da revisão corrente.
    const liveScenes = scenes.filter((s) => s.status !== McSceneStatus.CANCELED);
    const allFinalsDone =
      liveScenes.length > 0 &&
      liveScenes.every((scene) => {
        if (scene.status === McSceneStatus.READY) return true;
        const plan = scenePlan(sceneTypeOf(scene));
        return isDone(currentGenerationSteps(scene, steps, revision)[plan.final]);
      });
    for (const [position, type] of chain.entries()) {
      const pending = projectStep(type, McStepStatus.PENDING);
      if (!pending) continue;
      // Quadro parado da peça (6.3): só precisa do descritor congelado — libera
      // assim que está pendente, enquanto as falas ainda gravam.
      if (isSceneIndependentProjectStep(type)) {
        ready.push(toRef(pending));
        continue;
      }
      // O primeiro step que precisa das cenas (tudo antes dele é independente
      // delas) espera TODAS as cenas vivas com final pronto…
      const needsScenes = chain.slice(0, position).every(isSceneIndependentProjectStep);
      if (needsScenes && !allFinalsDone) continue;
      if (position === 0) {
        ready.push(toRef(pending));
        continue;
      }
      // …e, como todo seguinte, o anterior concluído na MESMA cadeia: a cadeia
      // de UMA entrega compartilha o `attempt` (materializer) — um compose
      // concluído de uma entrega anterior da mesma revisão nunca destrava o
      // finalize da entrega nova.
      const previousType = chain[position - 1];
      const attempt = pending.attempt ?? 1;
      const previousDone =
        projectStep(previousType, McStepStatus.SUCCEEDED, attempt) ??
        projectStep(previousType, McStepStatus.SKIPPED_CACHED, attempt);
      if (previousDone) ready.push(toRef(pending));
    }
  }
  return ready;
}

/**
 * Preparação concluída (ADR §4.1): TODAS as cenas vivas têm os steps de
 * preparação do seu plano concluídos (sucesso OU cache) na geração e revisão
 * correntes. Cache integral ⇒ true imediatamente, sem esperar callback.
 */
export function preparationComplete(
  project: Pick<SchedulerProject, 'revision'>,
  scenes: SchedulerScene[],
  steps: SchedulerStep[],
): boolean {
  const live = scenes.filter((s) => s.status !== McSceneStatus.CANCELED);
  if (live.length === 0) return false;
  return live.every((scene) => {
    const plan = scenePlan(sceneTypeOf(scene));
    const byType = currentGenerationSteps(scene, steps, project.revision ?? null);
    return plan.preparation.every((type) => isDone(byType[type]));
  });
}

/** Steps de preparação PENDENTES/em curso de uma cena (para a UI e o watchdog). */
export function scenePlanSteps(scene: SchedulerScene): McStepType[] {
  return planSteps(scenePlan(sceneTypeOf(scene)));
}
