import { maskBounds, maskShapeProblem, MAX_MASK_POINTS } from './scene-mask-shape';

const brush = (n: number, radius = 0.02) => ({
  kind: 'brush',
  radius,
  strokes: [Array.from({ length: n }, (_v, i) => ({ x: (i % 100) / 100, y: 0.5 }))],
});

describe('maskShapeProblem', () => {
  it('aceita pincel e laço válidos', () => {
    expect(maskShapeProblem(brush(10))).toBeNull();
    expect(
      maskShapeProblem({
        kind: 'lasso',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0.5, y: 1 },
        ],
      }),
    ).toBeNull();
  });

  it('aceita exatamente 2000 pontos e recusa 2001', () => {
    expect(maskShapeProblem(brush(MAX_MASK_POINTS))).toBeNull();
    expect(maskShapeProblem(brush(MAX_MASK_POINTS + 1))).toMatch(/2000/);
  });

  it.each([
    [null],
    ['x'],
    [{ kind: 'circle' }],
    [{ kind: 'brush', radius: 0, strokes: [[{ x: 0, y: 0 }]] }],
    [{ kind: 'brush', radius: 0.9, strokes: [[{ x: 0, y: 0 }]] }],
    [{ kind: 'brush', radius: 0.02, strokes: [] }],
    [{ kind: 'brush', radius: 0.02, strokes: [[]] }],
    [{ kind: 'brush', radius: 0.02, strokes: ['x'] }],
    [{ kind: 'brush', radius: 0.02, strokes: [[{ x: 2, y: 0 }]] }],
    [
      {
        kind: 'lasso',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ],
    [{ kind: 'lasso', points: 'x' }],
    [
      {
        kind: 'lasso',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: -0.1, y: 0.5 },
        ],
      },
    ],
    [
      {
        kind: 'lasso',
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: Number.NaN, y: 0.5 },
        ],
      },
    ],
  ])('recusa %j', (shape) => {
    expect(maskShapeProblem(shape)).not.toBeNull();
  });
});

describe('maskBounds', () => {
  it('laço: a caixa dos pontos', () => {
    const rect = maskBounds(
      {
        kind: 'lasso',
        points: [
          { x: 0.2, y: 0.3 },
          { x: 0.6, y: 0.3 },
          { x: 0.4, y: 0.7 },
        ],
      },
      2,
    );
    expect(rect.x).toBeCloseTo(0.2);
    expect(rect.y).toBeCloseTo(0.3);
    expect(rect.w).toBeCloseTo(0.4);
    expect(rect.h).toBeCloseTo(0.4);
  });

  it('pincel: soma a espessura (em y pela proporção da cena) e fica dentro da cena', () => {
    const rect = maskBounds(
      {
        kind: 'brush',
        radius: 0.05,
        strokes: [
          [
            { x: 0.02, y: 0.5 },
            { x: 0.5, y: 0.5 },
          ],
        ],
      },
      2,
    );
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(0.4);
    expect(rect.h).toBeCloseTo(0.2);
  });
});
