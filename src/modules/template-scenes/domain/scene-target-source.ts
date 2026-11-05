import { LocalTarget, SceneClassification } from './scene-operation.classifier';
import { SceneZoneName } from './scene.types';

/** De onde veio a área entendida: marcada pelo cliente, zona pelo campo, zona pelo texto ou camada. */
export type SceneTargetSource = 'marked' | 'zone_field' | 'zone_text' | 'element';

const targetSource = (target: LocalTarget | null): SceneTargetSource | null => {
  if (!target) return null;
  if (target.kind === 'rect' || target.kind === 'mask') return 'marked';
  if (target.kind === 'element') return 'element';
  return target.from === 'text' ? 'zone_text' : 'zone_field';
};

/** Origem do alvo do plano gravado na versão (`null` nas operações sem área). */
export function targetSourceOf(
  plan: SceneClassification | null | undefined,
): SceneTargetSource | null {
  if (plan?.operation !== 'local_edit' && plan?.operation !== 'add_element') return null;
  return targetSource(plan.target);
}

export const ZONE_LABEL: Record<SceneZoneName, string> = {
  header: 'cabeçalho',
  body: 'miolo',
  footer: 'rodapé',
};
