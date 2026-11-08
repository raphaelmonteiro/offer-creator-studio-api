import { findSceneFormat } from '../domain/scene-formats';
import { SceneElement } from '../domain/scene.types';
import { coverLogoBox } from './scene-layer-cover';
import { heightFraction } from './scene-layer-target';
import { TurnContext } from './scene-turn-state';

/**
 * PV-T11: ao diminuir o cabeçalho da capa, a logo (camada) que estava no cabeçalho e agora sai dele é reduzida e
 * reposicionada dentro do novo quadrado da logo, sem chamada de imagem. Ao aumentar, nada muda. `null` quando nenhuma
 * logo precisa mexer.
 */
export function fitLogosToHeader(
  elements: SceneElement[],
  ctx: Pick<TurnContext, 'headerResize' | 'zones' | 'formatId' | 'widthPx' | 'heightPx'>,
): SceneElement[] | null {
  const { headerResize, zones } = ctx;
  const format = findSceneFormat(ctx.formatId);
  if (!headerResize || !format || headerResize.toCm >= headerResize.fromCm) return null;
  const oldHeight = headerResize.fromCm / format.printHeightCm;
  let changed = false;
  const fitted = elements.map((element) => {
    if (element.kind !== 'logo') return element;
    const height = heightFraction(element, ctx);
    const inOldHeader = element.y < oldHeight && element.x >= zones.header.x;
    const leaves = element.y + height / 2 > zones.header.h;
    if (!inOldHeader || !leaves) return element;
    changed = true;
    const box = coverLogoBox({ ...ctx, zones }, 'header', element.aspect);
    return box ? { ...element, ...box } : element;
  });
  return changed ? fitted : null;
}
