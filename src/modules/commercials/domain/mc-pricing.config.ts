import { McScript, McScriptScene, McStepType } from './mc-types';

/**
 * Tabela de créditos por tipo de step (plano-comerciais §8).
 * 1 crédito = R$ 0,10. Nunca hardcodar custos nos services — este arquivo é a
 * fonte única, revisável sem tocar em lógica (mesmo papel do pricing.config
 * do módulo de animações).
 *
 * Decomposição dos preços do plano §8:
 * - cena sem fala  ~90 cr = keyframe 1 + video 89
 * - cena falada   ~150 cr = keyframe 1 + video 89 + tts 4 + lipsync 56
 * - script e assembly (montagem/re-montagem/selos/legendas) são inclusos (0).
 *
 * CALIBRAÇÃO: estes valores são a tabela de LANÇAMENTO do plano; a calibração
 * final vem da telemetria (`providerCostUsd` real por step, margem alvo
 * 2,5–3×) ANTES do go-live — a tabela antiga do módulo de animações nunca foi
 * calibrada e esse erro não se repete aqui (plano §8/§6.7).
 */
export const MC_STEP_CREDITS: Record<McStepType, number> = {
  [McStepType.SCRIPT]: 0,
  [McStepType.KEYFRAME]: 1,
  [McStepType.VIDEO]: 89,
  [McStepType.TTS]: 4,
  [McStepType.LIPSYNC]: 56,
  [McStepType.ASSEMBLY]: 0,
};

/** Kit do mascote (Ativo de Personagem, 1× por mascote): 30 cr = R$ 3 (§8). */
export const MC_KIT_CREDITS = 30;

/**
 * Mini-reserva fixa na criação do projeto (roteiro + keyframes ≈ centavos) —
 * a reserva principal acontece na aprovação do storyboard (plano §6.7).
 * Debitada em createProject quando creditsEnabled('commercials').
 */
export const MC_PROJECT_MINI_RESERVE_CREDITS = 10;

/** Steps que uma cena gera: muda = keyframe→video; falada soma tts+lipsync. */
export function stepsDaCena(scene: Pick<McScriptScene, 'dialogue'>): McStepType[] {
  const spoken = scene.dialogue !== null && scene.dialogue !== undefined && scene.dialogue !== '';
  return spoken
    ? [McStepType.KEYFRAME, McStepType.VIDEO, McStepType.TTS, McStepType.LIPSYNC]
    : [McStepType.KEYFRAME, McStepType.VIDEO];
}

/** Custo em créditos de uma cena (90 muda / 150 falada, derivado da tabela). */
export function custoDaCena(scene: Pick<McScriptScene, 'dialogue'>): number {
  return stepsDaCena(scene).reduce((sum, type) => sum + MC_STEP_CREDITS[type], 0);
}

/**
 * Custo total do projeto a partir do roteiro aprovado — é o valor da reserva
 * principal na aprovação do storyboard (plano §6.7). Script e assembly entram
 * pela tabela (hoje 0 = inclusos no preço das cenas).
 */
export function custoDoProjeto(script: Pick<McScript, 'scenes'>): number {
  const scenesCost = script.scenes.reduce((sum, scene) => sum + custoDaCena(scene), 0);
  return scenesCost + MC_STEP_CREDITS[McStepType.SCRIPT] + MC_STEP_CREDITS[McStepType.ASSEMBLY];
}
