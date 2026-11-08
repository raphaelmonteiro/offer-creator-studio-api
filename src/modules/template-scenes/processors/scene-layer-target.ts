import { SceneElement, SceneZones } from '../domain/scene.types';
import { LayerTarget } from '../domain/scene-layer.types';
import { TurnAttachmentAsset } from './scene-turn-state';

export interface LayerContext {
  zones: SceneZones;
  widthPx: number;
  heightPx: number;
  elements: SceneElement[];
  attachments: TurnAttachmentAsset[];
}

const KIND_LABEL: Record<string, { name: string; article: string; plural: string }> = {
  logo: { name: 'logo', article: 'a', plural: 'uma' },
  text: { name: 'texto', article: 'o', plural: 'um' },
};

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Altura do elemento em fração da altura da cena. */
export function heightFraction(el: SceneElement, ctx: LayerContext): number {
  return (el.w * ctx.widthPx) / el.aspect / ctx.heightPx;
}

/** Procura o alvo pelo id selecionado ou pelo tipo citado; 0 ou 2+ do tipo viram resposta ao cliente. */
export function findTarget(
  target: LayerTarget,
  elements: SceneElement[],
): { element: SceneElement } | { reply: string } {
  if ('elementId' in target) {
    const found = elements.find((e) => e.id === target.elementId);
    return found
      ? { element: found }
      : { reply: 'Não encontrei esse elemento na cena. Nada foi alterado.' };
  }
  const same = elements.filter((e) => e.kind === target.kind);
  const label = KIND_LABEL[target.kind];
  if (same.length === 0) {
    return { reply: `Não encontrei ${label.article} ${label.name} na cena. Nada foi alterado.` };
  }
  if (same.length > 1) {
    return {
      reply: `Há mais de ${label.plural} ${label.name}. Selecione na prévia qual quer mudar. Nada foi alterado.`,
    };
  }
  return { element: same[0] };
}
