import { fold } from '../../../shared/text/fold';
import { layerNamedIn } from '../domain/scene-layer-name';
import { BelowRef } from '../domain/scene-layer.types';
import { SceneElement } from '../domain/scene.types';
import { noRoomBelowReply } from '../scene-texts';
import { clamp, findTarget, heightFraction, LayerContext } from './scene-layer-target';

/** Folga entre a base da camada citada e o topo da caixa de baixo, em fração da altura da página (B3). */
const BELOW_GAP = 0.01;

/** Estado de uma aplicação: as camadas criadas antes, na mesma lista, que "embaixo de X" pode citar. */
export interface RunState {
  created: Set<string>;
}

type Box = { x: number; y: number; w: number; h: number };
const boxOf = (el: SceneElement, ctx: LayerContext): Box => ({
  x: el.x,
  y: el.y,
  w: el.w,
  h: heightFraction(el, ctx),
});
const overlaps = (a: Box, b: Box): boolean =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;

/** A camada citada em "embaixo de X": a criada antes na lista, ou a única do tipo (ou do nome); 0 ou 2+ viram resposta. */
function findBelowRef(
  ref: BelowRef,
  elements: SceneElement[],
  state: RunState,
): { element: SceneElement } | { reply: string } {
  const ofKind = elements.filter((e) => e.kind === ref.kind);
  const fresh = ofKind.filter((e) => state.created.has(e.id));
  if (fresh.length) return { element: fresh[fresh.length - 1] };
  if (ref.kind !== 'generated') return findTarget({ kind: ref.kind }, elements);
  const named = ref.name ? ofKind.filter((e) => layerNamedIn(e, fold(ref.name as string))) : ofKind;
  return named.length === 1
    ? { element: named[0] }
    : { reply: 'Selecione na prévia a camada de referência. Nada foi alterado.' };
}

/**
 * Centro da caixa `w` x `aspect` logo abaixo da base da camada de referência, alinhada pelo lado dela (borda esquerda
 * com a esquerda, centro com o centro, borda direita com a direita), dentro da página e sem sobrepor (B3). `null` quando
 * não há espaço abaixo.
 */
function placeBelow(
  ref: SceneElement,
  size: { w: number; aspect: number },
  ctx: LayerContext,
): [number, number] | null {
  const refBox = boxOf(ref, ctx);
  const h = heightFraction(size as SceneElement, ctx);
  const top = refBox.y + refBox.h / 2 + BELOW_GAP;
  if (top + h > 1) return null;
  const side = ref.x < 1 / 3 ? 'left' : ref.x > 2 / 3 ? 'right' : 'center';
  const aligned =
    side === 'left'
      ? ref.x - ref.w / 2 + size.w / 2
      : side === 'right'
        ? ref.x + ref.w / 2 - size.w / 2
        : ref.x;
  const x = clamp(aligned, size.w / 2, 1 - size.w / 2);
  const y = top + h / 2;
  return overlaps(refBox, { x, y, w: size.w, h }) ? null : [x, y];
}

/** O lugar de uma camada "embaixo de X", ou a resposta ao cliente (referência ausente, ambígua ou sem espaço). */
export function belowSpot(
  below: BelowRef,
  size: { w: number; aspect: number },
  input: { ctx: LayerContext; elements: SceneElement[]; state: RunState },
): { at: [number, number] } | { reply: string } {
  const found = findBelowRef(below, input.elements, input.state);
  if ('reply' in found) return found;
  const at = placeBelow(found.element, size, input.ctx);
  return at ? { at } : { reply: noRoomBelowReply(found.element.name) };
}
