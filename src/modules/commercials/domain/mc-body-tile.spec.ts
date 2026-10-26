import { findFigureBox, identityCutAtBottom, planBodyTile } from './mc-body-tile';

function alphaWithRect(w: number, h: number, r: { x: number; y: number; w: number; h: number }) {
  const a = new Uint8Array(w * h);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) a[y * w + x] = 255;
  return a;
}

describe('planBodyTile', () => {
  const bbox = { x: 0.35, y: 0.05, w: 0.3, h: 0.2 };

  it('figura vazia → BODY_TILE_FIGURE_NOT_FOUND', () => {
    expect(planBodyTile({ width: 100, height: 100, alpha: new Uint8Array(10_000), bbox })).toEqual({
      ok: false,
      code: 'BODY_TILE_FIGURE_NOT_FOUND',
    });
  });

  it('ruído de 1 pixel não conta para a caixa da figura', () => {
    const a = alphaWithRect(100, 100, { x: 30, y: 20, w: 40, h: 60 });
    a[0] = 255; // pixel solto no canto
    expect(findFigureBox(a, 100, 100)).toEqual({ left: 30, top: 20, width: 40, height: 60 });
  });

  it('identidade cortada embaixo: o tile termina na borda inferior', () => {
    const alpha = alphaWithRect(200, 400, { x: 60, y: 40, w: 80, h: 360 });
    expect(identityCutAtBottom(alpha, 200, 400)).toBe(true);
    const result = planBodyTile({
      width: 200,
      height: 400,
      alpha,
      bbox: { x: 0.3, y: 0.1, w: 0.4, h: 0.3 },
    });
    if (!('plan' in result)) throw new Error('esperava plano');
    expect(result.plan.tile.top + result.plan.tile.height).toBe(400);
    expect(result.plan.tile.top).toBeLessThan(40);
    expect(result.plan.extend.top).toBeGreaterThanOrEqual(0);
  });

  it('proporção sempre em [0,5; 1,0] e lado menor ≥ 720 px', () => {
    const wide = alphaWithRect(1000, 300, { x: 50, y: 20, w: 900, h: 200 });
    const narrow = alphaWithRect(300, 1000, { x: 140, y: 20, w: 20, h: 900 });
    for (const [w, h, alpha] of [
      [1000, 300, wide],
      [300, 1000, narrow],
    ] as const) {
      const result = planBodyTile({
        width: w,
        height: h,
        alpha,
        bbox: { x: 0.4, y: 0.02, w: 0.2, h: 0.1 },
      });
      if (!('plan' in result)) throw new Error('esperava plano');
      expect(result.plan.ratio).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(result.plan.ratio).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.min(result.plan.output.width, result.plan.output.height)).toBeGreaterThanOrEqual(
        720,
      );
    }
  });
});
