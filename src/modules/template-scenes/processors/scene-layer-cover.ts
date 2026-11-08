import { effectiveZone } from '../domain/scene-faces';
import { logoSpace } from '../domain/scene-tabloid';
import { Rect, SceneZoneName, SceneZones } from '../domain/scene.types';

/**
 * Posição das camadas no jornal (change add-template-scene-tabloid): nas zonas de meia largura o lado vale dentro da
 * zona, e a logo do cabeçalho da capa nasce no espaço reservado para ela (PV-T4).
 */

/** Margem lateral das camadas dentro da zona, em fração da largura da página. */
export const SIDE_MARGIN = 0.04;

/** O `x` (centro) de uma camada de largura `width` no lado pedido da zona; na zona inteira, o de sempre. */
export function sideX(side: 'left' | 'center' | 'right', zone: Rect, width: number): number {
  if (side === 'left') return zone.x + SIDE_MARGIN + width / 2;
  if (side === 'right') return zone.x + zone.w - SIDE_MARGIN - width / 2;
  return zone.x + zone.w / 2;
}

/**
 * A logo pedida no cabeçalho da Externa (PV-T4): centro do quadrado da logo, com o lado maior até o lado do quadrado.
 * `null` fora do jornal, na Interna (sem cabeçalho) e em outra zona: vale a regra do miolo.
 */
export function coverLogoBox(
  input: { zones: SceneZones; widthPx: number; heightPx: number },
  zone: SceneZoneName,
  aspect: number,
): { x: number; y: number; w: number } | null {
  const { zones } = input;
  if (!zones.fold || effectiveZone(zone, zones) !== 'header') return null;
  const space = logoSpace(zones, input);
  const widthPx = aspect >= 1 ? space.sidePx : space.sidePx * aspect;
  return { x: space.centerX, y: space.centerY, w: widthPx / input.widthPx };
}
