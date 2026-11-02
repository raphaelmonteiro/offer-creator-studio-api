import type { Arm } from './budget';
import type { CasesFile, EditCase, MaskShape, Rect, RegionSpec } from './types';

export type JobVariant = 'base' | 'rect' | 'shape' | 'm8';

export interface EditJob {
  key: string;
  block: 'A' | 'C';
  edit: EditCase;
  arm: Arm;
  variant: JobVariant;
  marginFraction: number;
}

export const MARGIN_DEFAULT = 0.04;
export const MARGIN_WIDE = 0.08;

/** Forma (S) de um pedido na variante pedida (no bloco C, `rect` usa só o retângulo). */
export function specOf(job: EditJob): RegionSpec {
  const e = job.edit;
  if (job.variant === 'rect') return { kind: 'rect', rect: e.region as Rect };
  if (e.shapeKind === 'zone') return { kind: 'zone', zone: e.zone! };
  if (e.shapeKind === 'rect') return { kind: 'rect', rect: e.region as Rect };
  return e.mask as MaskShape;
}

/** Jobs de edição na ordem do design: A com mask, A com markup, C, e a margem de 8% (varredura paga). */
export function editJobs(cases: CasesFile): { a: EditJob[]; c: EditJob[]; margin: EditJob[] } {
  const A = cases.edits.filter((e) => e.block === 'A');
  const mk = (
    e: EditCase,
    arm: Arm,
    variant: JobVariant,
    suffix: string,
    margin: number,
  ): EditJob => ({
    key: `${e.id}:${suffix}`,
    block: e.block,
    edit: e,
    arm,
    variant,
    marginFraction: margin,
  });
  return {
    a: [
      ...A.map((e) => mk(e, 'mask', 'base', 'mask', MARGIN_DEFAULT)),
      ...A.map((e) => mk(e, 'markup', 'base', 'markup', MARGIN_DEFAULT)),
    ],
    c: cases.edits
      .filter((e) => e.block === 'C')
      .flatMap((e) => [
        mk(e, 'mask', 'rect', 'rect', MARGIN_DEFAULT),
        mk(e, 'mask', 'shape', 'shape', MARGIN_DEFAULT),
      ]),
    margin: cases.marginSubset.map((id) =>
      mk(A.find((e) => e.id === id) as EditCase, 'mask', 'm8', 'm8', MARGIN_WIDE),
    ),
  };
}
