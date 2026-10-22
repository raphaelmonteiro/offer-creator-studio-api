import { McPieceRect } from './mc-piece';

/**
 * Auto-layout da área de produtos da peça (change video-peca-configuravel,
 * tarefa 3.1) — CÓPIA FIEL de `src/lib/video-templates/piece/layoutProducts.ts`
 * do frontend (casa provisória do que vai para `@chroma/video-templates`).
 * Enquanto o pacote não existe, o quadro mock do worker usa ESTE arquivo para
 * desenhar as mesmas células que o editor mostra; o spec fixa os mesmos
 * números do teste do frontend para garantir a paridade.
 *
 * Distribuições (colunas por quantidade): 1 → 1; 2 → 2; 3 → 3 em área larga
 * (w/h ≥ 1,2) ou 2+1; 4 → 2×2; 5–9 → 3 colunas; 10–12 → 4. Com destaque
 * (N ≥ 3) ele ocupa 2 colunas na primeira linha. Folga = 2% da largura da área.
 */

export interface PieceLayoutInput {
  areaRect: McPieceRect;
  width: number;
  height: number;
  itemIds: string[];
  featuredId?: string | null;
}

export interface PieceLayoutResult {
  rects: Record<string, McPieceRect>;
  cols: number;
  rows: number;
  cellPx: { width: number; height: number };
  textScale: number;
}

export const PIECE_LAYOUT_GAP_RATIO = 0.02;
export const PIECE_PRICE_MIN_PX_AT_1080 = 36;
export const PIECE_NAME_MIN_PX_AT_1080 = 24;
export const PIECE_PRICE_BASE_RATIO = 0.16;
export const PIECE_NAME_BASE_RATIO = 0.09;

export function pieceLayoutColumns(count: number, areaAspect: number): number {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count === 3) return areaAspect >= 1.2 ? 3 : 2;
  if (count === 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

export function pieceProductTextSizes(
  cellWidthPx: number,
  frameWidthPx: number,
): { pricePx: number; namePx: number; scale: number } {
  const unit = frameWidthPx / 1080;
  const priceMin = PIECE_PRICE_MIN_PX_AT_1080 * unit;
  const nameMin = PIECE_NAME_MIN_PX_AT_1080 * unit;
  const priceBase = cellWidthPx * PIECE_PRICE_BASE_RATIO;
  const nameBase = cellWidthPx * PIECE_NAME_BASE_RATIO;
  const scale = Math.max(1, priceMin / priceBase, nameMin / nameBase);
  return {
    pricePx: Math.round(priceBase * scale),
    namePx: Math.round(nameBase * scale),
    scale: Number(scale.toFixed(4)),
  };
}

const round = (value: number) => Number(value.toFixed(5));

export function layoutPieceProducts(input: PieceLayoutInput): PieceLayoutResult {
  const { areaRect, width, height } = input;
  const ids = input.itemIds.filter((id, i, all) => all.indexOf(id) === i);
  const count = ids.length;
  if (count === 0) {
    return { rects: {}, cols: 0, rows: 0, cellPx: { width: 0, height: 0 }, textScale: 1 };
  }
  const areaPx = { w: areaRect.w * width, h: areaRect.h * height };
  const featured =
    input.featuredId && count >= 3 && ids.includes(input.featuredId) ? input.featuredId : null;
  const cols = pieceLayoutColumns(count, areaPx.w / Math.max(1, areaPx.h));
  const firstRowOthers = featured ? Math.max(0, cols - 2) : cols;
  const rest = featured ? count - 1 - firstRowOthers : count;
  const rows = featured ? 1 + Math.ceil(Math.max(0, rest) / cols) : Math.ceil(count / cols);
  const gapX = areaRect.w * PIECE_LAYOUT_GAP_RATIO;
  const gapY = (gapX * width) / height;
  const cellW = (areaRect.w - gapX * (cols + 1)) / cols;
  const cellH = (areaRect.h - gapY * (rows + 1)) / rows;

  const rects: Record<string, McPieceRect> = {};
  const place = (id: string, col: number, row: number, span = 1) => {
    rects[id] = {
      x: round(areaRect.x + gapX + col * (cellW + gapX)),
      y: round(areaRect.y + gapY + row * (cellH + gapY)),
      w: round(cellW * span + gapX * (span - 1)),
      h: round(cellH),
    };
  };
  const ordered = featured ? [featured, ...ids.filter((id) => id !== featured)] : ids;
  let index = 0;
  if (featured) {
    place(featured, 0, 0, Math.min(2, cols));
    index = 1;
    for (let col = Math.min(2, cols); col < cols && index < ordered.length; col += 1) {
      place(ordered[index], col, 0);
      index += 1;
    }
  }
  let row = featured ? 1 : 0;
  while (index < ordered.length) {
    for (let col = 0; col < cols && index < ordered.length; col += 1) {
      place(ordered[index], col, row);
      index += 1;
    }
    row += 1;
  }
  const cellPx = { width: Math.round(cellW * width), height: Math.round(cellH * height) };
  return {
    rects,
    cols,
    rows,
    cellPx,
    textScale: pieceProductTextSizes(cellPx.width, width).scale,
  };
}
