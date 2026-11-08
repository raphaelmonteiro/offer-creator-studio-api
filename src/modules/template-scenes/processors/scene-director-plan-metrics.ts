import { DirectorPlan } from '../domain/scene-director-schema';
import { SceneVersionMetrics } from '../domain/scene.types';
import { PlanPatches } from './scene-director-validate';

/**
 * `metrics` da versão de leitura com o plano aceito e, se o código cortou algum trecho depois de refazer uma vez,
 * o que foi cortado (número, texto fora do bloco, anúncio barrado) e `planPatched`.
 */
export function planMetrics(
  metrics: SceneVersionMetrics,
  plan: DirectorPlan,
  patches?: PlanPatches,
): SceneVersionMetrics {
  if (!patches) return { ...metrics, plan };
  return {
    ...metrics,
    plan,
    planPatched: true,
    ...(patches.number ? { numberPatches: patches.number } : {}),
    ...(patches.text ? { textPatches: patches.text } : {}),
    ...(patches.announcement ? { announcementPatch: patches.announcement } : {}),
  };
}
