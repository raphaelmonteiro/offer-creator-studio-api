import { Rect, SceneElement } from './scene.types';

/** Retângulo normalizado de um elemento (centro, largura e proporção), preso à cena. */
export function elementRect(el: SceneElement, size: { widthPx: number; heightPx: number }): Rect {
  const h = (el.w * size.widthPx) / el.aspect / size.heightPx;
  const x = Math.max(0, el.x - el.w / 2);
  const y = Math.max(0, el.y - h / 2);
  return { x, y, w: Math.min(el.w, 1 - x), h: Math.min(h, 1 - y) };
}
