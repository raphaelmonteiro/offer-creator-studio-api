import { Box } from '../../../shared/image/raster';
import { computeCrop, DEFAULT_INSET_PX, insetOnScene, MAX_STRETCH } from './scene-region';

const MIN = 655_360;
const contains = (outer: Box, inner: Box) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.w >= inner.x + inner.w &&
  outer.y + outer.h >= inner.y + inner.h;

function check(W: number, H: number, region: Box) {
  const plan = computeCrop(W, H, region);
  const { box } = plan;
  expect(box.w % 16).toBe(0);
  expect(box.h % 16).toBe(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.w).toBeLessThanOrEqual(W);
  expect(box.y + box.h).toBeLessThanOrEqual(H);
  expect(contains(box, region)).toBe(true);
  expect(plan.sendW).toBeLessThanOrEqual(1024);
  expect(plan.sendH).toBeLessThanOrEqual(1024);
  expect(plan.sendW % 16).toBe(0);
  expect(plan.sendH % 16).toBe(0);
  return plan;
}

describe('computeCrop (casos do selftest do spike)', () => {
  it('região média: sem crescer nem reduzir', () => {
    const plan = check(1920, 3840, { x: 500, y: 1100, w: 922, h: 922 });
    expect(plan.grown).toBe(false);
    expect(plan.downscaled).toBe(false);
    expect(plan.sendW * plan.sendH).toBeGreaterThanOrEqual(MIN);
  });

  it('região minúscula: o recorte cresce em volta até a área mínima', () => {
    const plan = check(1920, 3840, { x: 760, y: 1530, w: 90, h: 90 });
    expect(plan.grown).toBe(true);
    expect(plan.downscaled).toBe(false);
    expect(plan.sendW * plan.sendH).toBeGreaterThanOrEqual(MIN);
    expect(plan.belowMinArea).toBe(false);
  });

  it('zona larga: reduz para caber em 1024x1024', () => {
    const plan = check(3520, 2336, { x: 0, y: 0, w: 3520, h: 560 });
    expect(plan.downscaled).toBe(true);
    expect(plan.scale).toBeLessThan(1);
    expect(plan.sendW * plan.sendH).toBeGreaterThanOrEqual(MIN);
  });

  it('região na borda: o recorte fica preso à imagem', () => {
    const plan = check(1920, 3840, { x: 0, y: 0, w: 38, h: 38 });
    expect(plan.box.x).toBe(0);
    expect(plan.box.y).toBe(0);
  });

  it('imagem baixa: estica o lado menor (altura) até a área mínima, com fator no teto', () => {
    const plan = check(3840, 2128, { x: 230, y: 1520, w: 3494, h: 340 });
    expect(plan.stretched).toBe(true);
    expect(plan.sendH).toBeLessThan(plan.sendW);
    expect(plan.stretchFactor).toBeLessThanOrEqual(MAX_STRETCH);
    expect(plan.belowMinArea).toBe(false);
  });

  it('retrato alto: estica a largura (lado menor)', () => {
    const plan = check(2128, 3840, { x: 1520, y: 230, w: 340, h: 3494 });
    expect(plan.stretched).toBe(true);
    expect(plan.sendW).toBeLessThan(plan.sendH);
    expect(plan.stretchFactor).toBeLessThanOrEqual(MAX_STRETCH);
  });

  it('acima do teto de distorção: não estica e fica abaixo da área mínima', () => {
    const plan = computeCrop(3840, 1200, { x: 0, y: 400, w: 3840, h: 120 });
    expect(plan.stretched).toBe(false);
    expect(plan.belowMinArea).toBe(true);
    expect(plan.stretchFactor).toBe(1);
  });
});

describe('insetOnScene', () => {
  it('é o recuo da saída dividido pela escala de redução', () => {
    expect(insetOnScene(1)).toBe(DEFAULT_INSET_PX);
    expect(insetOnScene(0.5)).toBe(80);
    expect(insetOnScene(2)).toBe(DEFAULT_INSET_PX);
    expect(insetOnScene(0.5, 20)).toBe(40);
  });
});
