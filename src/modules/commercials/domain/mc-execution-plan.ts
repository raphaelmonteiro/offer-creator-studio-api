import { McPhase } from './mc-quality';
import { McSceneType, McStepType } from './mc-types';

/**
 * Plano de execução por TIPO DE CENA (ADR-001 §3.1/§4.2) — a fonte única do
 * grafo que scheduler, materializer, orçamento, progresso e finalização
 * consomem no pipeline v2. Substitui as decisões espalhadas baseadas apenas em
 * `dialogue` (isSpokenScene), que continuam valendo SÓ para o executor legado.
 *
 * | Tipo             | Preparação        | Produção                 | Final          |
 * |------------------|-------------------|--------------------------|----------------|
 * | presenter        | keyframe, tts     | lipsync (Avatar)         | lipsync        |
 * | action           | keyframe          | video (motor de ação)    | video          |
 * | action_voiceover | keyframe, tts     | video → scene_compose    | scene_compose  |
 *
 * `action_voiceover` NUNCA dispara Avatar por ter diálogo — a locução é
 * sobreposta pelo `scene_compose` (FFmpeg) ao vídeo de ação.
 */
export interface McScenePlan {
  sceneType: McSceneType;
  preparation: McStepType[];
  production: McStepType[];
  /** Step cuja conclusão torna a cena pronta (finalAssetId). */
  final: McStepType;
  /** Dependências diretas de cada step (todas precisam estar concluídas). */
  deps: Partial<Record<McStepType, McStepType[]>>;
  usesAvatar: boolean;
  usesActionEngine: boolean;
  hasTts: boolean;
}

const PLANS: Record<McSceneType, McScenePlan> = {
  presenter: {
    sceneType: 'presenter',
    preparation: [McStepType.KEYFRAME, McStepType.TTS],
    production: [McStepType.LIPSYNC],
    final: McStepType.LIPSYNC,
    deps: { [McStepType.LIPSYNC]: [McStepType.KEYFRAME, McStepType.TTS] },
    usesAvatar: true,
    usesActionEngine: false,
    hasTts: true,
  },
  action: {
    sceneType: 'action',
    preparation: [McStepType.KEYFRAME],
    production: [McStepType.VIDEO],
    final: McStepType.VIDEO,
    deps: { [McStepType.VIDEO]: [McStepType.KEYFRAME] },
    usesAvatar: false,
    usesActionEngine: true,
    hasTts: false,
  },
  action_voiceover: {
    sceneType: 'action_voiceover',
    preparation: [McStepType.KEYFRAME, McStepType.TTS],
    production: [McStepType.VIDEO, McStepType.SCENE_COMPOSE],
    final: McStepType.SCENE_COMPOSE,
    deps: {
      [McStepType.VIDEO]: [McStepType.KEYFRAME],
      [McStepType.SCENE_COMPOSE]: [McStepType.VIDEO, McStepType.TTS],
    },
    usesAvatar: false,
    usesActionEngine: true,
    hasTts: true,
  },
};

export function scenePlan(sceneType: McSceneType): McScenePlan {
  const plan = PLANS[sceneType];
  if (!plan) throw new Error(`Tipo de cena desconhecido: ${String(sceneType)}`);
  return plan;
}

export function isSceneType(value: unknown): value is McSceneType {
  return value === 'presenter' || value === 'action' || value === 'action_voiceover';
}

/**
 * Tipo de cena de um registro LEGADO (sem `sceneType`): a interpretação
 * histórica por diálogo — falada = Avatar (presenter), muda = ação. Usada
 * apenas na conversão explícita e na leitura de projetos antigos; o v2 exige
 * o tipo gravado.
 */
export function legacySceneType(dialogue: string | null | undefined): McSceneType {
  return dialogue !== null && dialogue !== undefined && dialogue !== '' ? 'presenter' : 'action';
}

/** Tipo efetivo: o gravado (v2) ou a inferência legada por diálogo. */
export function resolveSceneType(scene: {
  sceneType?: McSceneType | null;
  dialogue: string | null;
}): McSceneType {
  return scene.sceneType ?? legacySceneType(scene.dialogue);
}

/** Todos os steps de cena do plano, na ordem preparação → produção. */
export function planSteps(plan: McScenePlan): McStepType[] {
  return [...plan.preparation, ...plan.production];
}

export function phaseOfStep(plan: McScenePlan, stepType: McStepType): McPhase | null {
  if (plan.preparation.includes(stepType)) return 'preparation';
  if (plan.production.includes(stepType)) return 'production';
  return null;
}

/** Validação fala × tipo (ADR §3.1): presenter/voiceover exigem fala; action não gera TTS. */
export function sceneTypeDialogueIssue(
  sceneType: McSceneType,
  dialogue: string | null | undefined,
): string | null {
  const spoken = dialogue !== null && dialogue !== undefined && dialogue.trim() !== '';
  if (scenePlan(sceneType).hasTts && !spoken) {
    return `Cena do tipo '${sceneType}' precisa de fala.`;
  }
  if (!scenePlan(sceneType).hasTts && spoken) {
    return `Cena do tipo 'action' não tem fala — use 'action_voiceover' para narrar sobre a ação.`;
  }
  return null;
}
