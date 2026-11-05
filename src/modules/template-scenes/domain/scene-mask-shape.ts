import { MaskShape, Pt, Rect } from './scene.types';

/** Limites do `MaskShape` (D-10; PV-1 e PV-4 do design da change). */
export const MAX_MASK_POINTS = 2000;
/** Área mínima da forma: 0,1% da cena (abaixo disso, 422 `REGION_TOO_SMALL`). */
export const MIN_SHAPE_AREA_RATIO = 0.001;
const MAX_BRUSH_RADIUS = 0.5;

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const isPoint = (value: unknown): value is Pt => {
  const p = value as Pt | null;
  return typeof p === 'object' && p !== null && isUnit(p.x) && isUnit(p.y);
};

const POINT_KEYS = ['x', 'y'];
const LASSO_KEYS = ['kind', 'points'];
const BRUSH_KEYS = ['kind', 'strokes', 'radius'];

/** Só as chaves do contrato: a forma é gravada inteira e volta na `VersionView` (campo extra é recusado). */
const hasOnlyKeys = (value: object, allowed: string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key));

const isCleanPoint = (value: unknown): boolean => isPoint(value) && hasOnlyKeys(value, POINT_KEYS);

const POINT_PROBLEM = 'os pontos precisam ter só x e y, entre 0 e 1';

function brushRadiusProblem(radius: unknown): string | null {
  return typeof radius === 'number' && radius > 0 && radius <= MAX_BRUSH_RADIUS
    ? null
    : `o raio do pincel precisa estar entre 0 e ${MAX_BRUSH_RADIUS}`;
}

function strokesProblem(strokes: unknown): string | null {
  if (!Array.isArray(strokes) || strokes.length === 0)
    return 'o pincel precisa de ao menos um traço';
  if (strokes.length > MAX_MASK_POINTS) return `a forma passa de ${MAX_MASK_POINTS} traços`;
  let total = 0;
  for (const stroke of strokes) {
    if (!Array.isArray(stroke) || stroke.length === 0)
      return 'cada traço do pincel é uma lista com ao menos um ponto';
    total += stroke.length;
    if (total > MAX_MASK_POINTS) return `a forma passa de ${MAX_MASK_POINTS} pontos`;
    if (!stroke.every(isCleanPoint)) return POINT_PROBLEM;
  }
  return null;
}

function brushProblem(shape: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(shape, BRUSH_KEYS)) return 'a máscara tem campos que o contrato não aceita';
  return brushRadiusProblem(shape.radius) ?? strokesProblem(shape.strokes);
}

function lassoProblem(shape: Record<string, unknown>): string | null {
  if (!hasOnlyKeys(shape, LASSO_KEYS)) return 'a máscara tem campos que o contrato não aceita';
  const { points } = shape;
  if (!Array.isArray(points) || points.length < 3) return 'o laço precisa de ao menos 3 pontos';
  if (points.length > MAX_MASK_POINTS) return `a forma passa de ${MAX_MASK_POINTS} pontos`;
  return points.every(isCleanPoint) ? null : POINT_PROBLEM;
}

/** Motivo da recusa da forma (em pt-BR), ou `null` quando é válida. */
export function maskShapeProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'a máscara precisa ser um objeto';
  const shape = value as Record<string, unknown>;
  if (shape.kind === 'brush') return brushProblem(shape);
  if (shape.kind === 'lasso') return lassoProblem(shape);
  return 'a máscara precisa ser brush ou lasso';
}

/** Retângulo normalizado que contém a forma (o traço do pincel conta com a espessura). */
export function maskBounds(shape: MaskShape, sceneAspect: number): Rect {
  const points = shape.kind === 'brush' ? shape.strokes.flat() : shape.points;
  const padX = shape.kind === 'brush' ? shape.radius : 0;
  const padY = shape.kind === 'brush' ? shape.radius * sceneAspect : 0;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs) - padX);
  const y0 = Math.max(0, Math.min(...ys) - padY);
  const x1 = Math.min(1, Math.max(...xs) + padX);
  const y1 = Math.min(1, Math.max(...ys) + padY);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
