import { layoutProducts, LayoutProductsResult } from '@chroma/video-templates/core';
import { compositionDimensions } from './mc-composition.config';
import { McPieceAspectRatio, McPieceDocument, McPieceProductsBlock, pieceBlock } from './mc-piece';

/**
 * Re-layout da peça para OUTRO formato (change video-peca-configuravel,
 * tarefa 5.5 — "duplicar em 4:5"): a mesma peça reorganizada pelo auto-layout,
 * sem esticar nada (spec video-piece-editor "Troca de 9:16 para 4:5").
 *
 * Os dois formatos têm a mesma largura (1080); só a altura muda. Tudo na peça
 * é dimensionado pela largura ou cabe por `contain` (textos em fração da
 * largura, logo e fotos em contain, painel do personagem em contain), então os
 * blocos mantêm as FRAÇÕES do quadro — posição relativa igual, altura em px
 * proporcional, nada distorcido. A única parte que depende da proporção das
 * células é a grade de produtos: ela volta a `layout: 'auto'` (rects manuais
 * do formato antigo não valem no novo) e o `layoutProducts` do pacote — o
 * mesmo do editor e do quadro parado — redistribui as células.
 */

export interface PieceRelayoutResult {
  document: McPieceDocument;
  /** false quando o formato pedido é o atual (cópia fiel, inclusive layout manual). */
  changed: boolean;
  /** Grade calculada para o novo formato (null sem grade: imagem única ou sem itens). */
  layout: Pick<LayoutProductsResult, 'cols' | 'rows' | 'cellPx' | 'textScale'> | null;
}

export function relayoutPieceForAspect(
  source: McPieceDocument,
  aspectRatio: McPieceAspectRatio,
): PieceRelayoutResult {
  const document = JSON.parse(JSON.stringify(source)) as McPieceDocument;
  if (document.aspectRatio === aspectRatio) {
    return { document, changed: false, layout: null };
  }
  document.aspectRatio = aspectRatio;
  const products = pieceBlock(document, 'products') as McPieceProductsBlock | null;
  if (!products) return { document, changed: true, layout: null };
  products.layout = 'auto';
  products.items = (products.items ?? []).map((item) => {
    const { rect: _rect, ...rest } = item;
    return rest;
  });
  if (products.mode !== 'grid' || products.items.length === 0) {
    return { document, changed: true, layout: null };
  }
  const { width, height } = compositionDimensions(aspectRatio);
  const grid = layoutProducts({
    areaRect: products.rect,
    width,
    height,
    itemIds: products.items.map((i) => i.id),
    featuredId: products.items.find((i) => i.featured)?.id ?? null,
  });
  return {
    document,
    changed: true,
    layout: { cols: grid.cols, rows: grid.rows, cellPx: grid.cellPx, textScale: grid.textScale },
  };
}

/** Nome da peça clonada: "Ofertas da semana (4:5)", trocando um sufixo de formato anterior. */
export function pieceCopyName(name: string, aspectRatio: McPieceAspectRatio): string {
  const base = name.replace(/\s*\((?:9:16|4:5)\)\s*$/u, '').trim() || name;
  const suffix = ` (${aspectRatio})`;
  return `${base.slice(0, 120 - suffix.length)}${suffix}`;
}
