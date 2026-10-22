import { McPieceRect } from './mc-piece';
import { layoutPieceProducts, pieceLayoutColumns, pieceProductTextSizes } from './mc-piece-layout';

const AREA: McPieceRect = { x: 0.05, y: 0.2, w: 0.9, h: 0.52 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

/**
 * Paridade com `layoutProducts.test.ts` do frontend: os MESMOS números. Se um
 * lado mudar, este spec (ou o do front) quebra — é a garantia de que o quadro
 * mock do worker desenha as células que o editor mostra.
 */
describe('mc-piece-layout — auto-layout da área de produtos (cópia do pacote)', () => {
  it('colunas por quantidade iguais às do frontend', () => {
    expect([1, 2, 3, 4, 5, 9, 10, 12].map((n) => pieceLayoutColumns(n, 0.97))).toEqual([
      1, 2, 2, 2, 3, 3, 4, 4,
    ]);
    expect(pieceLayoutColumns(3, 1.5)).toBe(3);
  });

  it('4 produtos em 9:16 → 2×2 com os mesmos rects e tamanhos do frontend', () => {
    const result = layoutPieceProducts({
      areaRect: AREA,
      width: 1080,
      height: 1920,
      itemIds: ids(4),
    });
    expect([result.cols, result.rows]).toEqual([2, 2]);
    expect(result.rects.p1).toEqual({ x: 0.068, y: 0.21013, w: 0.423, h: 0.24481 });
    expect(result.rects.p4.x).toBeCloseTo(0.509, 5);
    expect(result.cellPx).toEqual({ width: 457, height: 470 });
    expect(result.textScale).toBe(1);
    expect(pieceProductTextSizes(457, 1080)).toEqual({ pricePx: 73, namePx: 41, scale: 1 });
  });

  it('destaque ocupa duas colunas; 12 itens em 4:5 → 4×3 com textos escalados aos mínimos', () => {
    const featured = layoutPieceProducts({
      areaRect: AREA,
      width: 1080,
      height: 1920,
      itemIds: ids(6),
      featuredId: 'p3',
    });
    expect([featured.cols, featured.rows]).toEqual([3, 3]);
    expect(featured.rects.p3.w).toBeCloseTo(featured.rects.p1.w * 2 + 0.018, 4);
    expect(featured.rects.p1.y).toBe(featured.rects.p3.y);
    const dense = layoutPieceProducts({
      areaRect: { x: 0.05, y: 0.18, w: 0.9, h: 0.6 },
      width: 1080,
      height: 1350,
      itemIds: ids(12),
    });
    expect([dense.cols, dense.rows, dense.cellPx.width]).toEqual([4, 3, 219]);
    expect(dense.textScale).toBeGreaterThan(1);
    expect(pieceProductTextSizes(219, 1080).pricePx).toBeGreaterThanOrEqual(36);
  });
});
