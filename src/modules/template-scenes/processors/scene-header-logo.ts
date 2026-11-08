import { findSceneFormat } from '../domain/scene-formats';
import { logoSpace } from '../domain/scene-tabloid';
import { SceneElement } from '../domain/scene.types';
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
  const space = logoSpace(zones, ctx);
  let changed = false;
  const fitted = elements.map((element) => {
    if (element.kind !== 'logo') return element;
    const heightFraction = (element.w * ctx.widthPx) / element.aspect / ctx.heightPx;
    const inOldHeader = element.y < oldHeight && element.x >= zones.header.x;
    const leaves = element.y + heightFraction / 2 > zones.header.h;
    if (!inOldHeader || !leaves) return element;
    changed = true;
    const widthPx = element.aspect >= 1 ? space.sidePx : space.sidePx * element.aspect;
    return { ...element, x: space.centerX, y: space.centerY, w: widthPx / ctx.widthPx };
  });
  return changed ? fitted : null;
}
