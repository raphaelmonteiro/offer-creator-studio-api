import { computeSceneZones, findSceneFormat } from '../domain/scene-formats';
import { DirectorImage } from '../domain/scene-director-schema';
import { Rect } from '../domain/scene.types';
import { zoneBands } from '../domain/scene-zone-bands';

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Margem do recorte em volta da marcação (D-51: 10%). */
const MARKED_MARGIN = 0.1;

/**
 * Recorte da região autorizada, na resolução da master, que o juiz recebe como imagem a mais para ler o texto
 * (`design.md`, "Leitura do texto"): a faixa da zona escolhida, ou a caixa da marcação com 10% de margem. Com
 * `region: whole` não há recorte: o juiz lê a imagem inteira.
 */
export function textCropBox(input: {
  region: DirectorImage['region'] | null;
  marking: Rect | null;
  formatId: string;
  width: number;
  height: number;
}): CropBox | null {
  const { region, marking, formatId, width, height } = input;
  if (marking) {
    const x0 = Math.max(0, marking.x - marking.w * MARKED_MARGIN);
    const y0 = Math.max(0, marking.y - marking.h * MARKED_MARGIN);
    const x1 = Math.min(1, marking.x + marking.w * (1 + MARKED_MARGIN));
    const y1 = Math.min(1, marking.y + marking.h * (1 + MARKED_MARGIN));
    return box(x0 * width, y0 * height, x1 * width, y1 * height, { width, height });
  }
  const format = findSceneFormat(formatId);
  if (!region || !format || region.zone === 'whole' || region.zone === 'marked') return null;
  const bands = zoneBands(computeSceneZones(format), height);
  const [from, to] =
    region.zone === 'header'
      ? [0, bands.headerEnd]
      : region.zone === 'footer'
        ? [bands.footerStart, height]
        : [bands.headerEnd, bands.footerStart];
  return box(0, from, width, to, { width, height });
}

function box(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: { width: number; height: number },
): CropBox | null {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const width = Math.min(size.width, Math.ceil(x1)) - left;
  const height = Math.min(size.height, Math.ceil(y1)) - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}
