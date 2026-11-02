import * as fs from 'fs';
import * as path from 'path';
import type { Arm } from './budget';
import { paidEdit } from './calls';
import type { Services } from './calls';
import { computeCrop } from './crop';
import type { CropPlan } from './crop';
import { cropImg, imgToPng, loadRgb, resizeImg } from './image';
import type { Img } from './image';
import { diffMetrics, FEATHER_SWEEP, tauSweep } from './metrics';
import { areaDiffRatio } from './metrics-extra';
import type { DiffMetrics } from './metrics';
import { areaOf, bboxOf, cropRaster, erode, resizeRaster, subtract, union } from './morph';
import type { Raster } from './morph';
import { DEFAULT_FEATHER, featherSweep, recompose, verifyOutside } from './recompose';
import { renderEditMask, renderMarkup, shapeAreaRatio } from './shapes';

/** Recuo (px) da região de recomposição em relação à região autorizada (decisão do dono, 2026-11-02). */
export const RECOMPOSE_INSET_PX = 40;

export interface EditStepArgs {
  svc: Services;
  /** Id no ledger e nos resultados, por exemplo `A01:mask`. */
  caseId: string;
  block: string;
  step: string;
  scene: Img;
  /** Forma (S) e região autorizada (A), do tamanho da cena. */
  shape: Raster;
  authorized: Raster;
  prompt: string;
  arm: Arm;
  /** Pasta onde gravar before, raw, final e a máscara. */
  dir: string;
  feather?: number;
  reference?: Buffer;
  /** Comparação de mecanismos (task extra): imagem inteira, polaridade da máscara, transporte e sem máscara. */
  variant?: {
    whole?: boolean;
    maskEditAlpha?: number;
    maskRgbFromImage?: boolean;
    transport?: 'json' | 'multipart';
    noMask?: boolean;
    /** false = a chamada não alimenta os contadores de recusa (P3). */
    track?: boolean;
  };
}

export interface EditOutcome {
  /** Cena inteira com o recorte recomposto. */
  final: Img;
  plan: CropPlan;
  metrics: Omit<DiffMetrics, 'outsideHistogram'> & {
    maskAreaRatio: number;
    seamSsim: number | null;
    /** Obediência na imagem recomposta: alterados na faixa de margem (região de recomposição fora de S). */
    marginDiffRatio: number;
  };
  outsideHistogram: number[];
  featherSweep: Array<{ feather: number; seamSsim: number | null }>;
  tauSweep: ReturnType<typeof tauSweep>;
  sizeMismatch: boolean;
  costUsd: number;
  requestId: string | null;
  latencyMs: Record<string, number>;
  files: { before: string; raw: string; final: string; mask: string };
  /** Para as métricas de preto da comparação. */
  beforeSent: Img;
  rawSent: Img;
  sentAuth: Raster;
  finalDefault: Img;
}

async function timed<T>(
  into: Record<string, number>,
  name: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    into[name] = Date.now() - t0;
  }
}

function write(file: string, data: Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

/**
 * Uma edição local completa: recorte, máscara ou marcação, chamada paga, recomposição com conferência
 * byte a byte, métricas e varreduras offline. Lança `RecomposeMismatchError` se a conferência falhar.
 */
export async function runEditStep(a: EditStepArgs): Promise<EditOutcome> {
  const latencyMs: Record<string, number> = {};
  const { scene } = a;
  const feather = a.feather ?? DEFAULT_FEATHER;
  const prep = await timed(latencyMs, 'crop', async () => {
    const plan: CropPlan = a.variant?.whole
      ? {
          box: { x: 0, y: 0, w: scene.width, h: scene.height },
          sendW: scene.width,
          sendH: scene.height,
          scale: 1,
          grown: false,
          downscaled: false,
          belowMinArea: false,
        }
      : computeCrop(scene.width, scene.height, bboxOf(a.authorized)!);
    const { box } = plan;
    const before = cropImg(scene, box.x, box.y, box.w, box.h);
    const sent = await resizeImg(before, plan.sendW, plan.sendH);
    return { plan, box, before, sent };
  });
  const size = { w: prep.plan.sendW, h: prep.plan.sendH };
  const sShape = resizeRaster(cropRaster(a.shape, prep.box), size.w, size.h);
  const sAuth = resizeRaster(cropRaster(a.authorized, prep.box), size.w, size.h);
  const v = a.variant ?? {};
  const maskPng = await timed(latencyMs, 'mask', () =>
    a.arm === 'mask'
      ? renderEditMask(sAuth, undefined, {
          editAlpha: v.maskEditAlpha,
          rgbFrom: v.maskRgbFromImage ? prep.sent : undefined,
        })
      : renderMarkup(sShape),
  );
  const imagePng = await imgToPng(prep.sent);
  const call = await timed(latencyMs, 'provider', () =>
    paidEdit(a.svc, {
      caseId: a.caseId,
      block: a.block,
      step: a.step,
      arm: v.track === false ? undefined : a.arm,
      params: {
        transport: v.transport,
        prompt: a.prompt,
        size: `${size.w}x${size.h}`,
        image: imagePng,
        reference: a.reference,
        ...(v.noMask ? {} : a.arm === 'mask' ? { mask: maskPng } : { markup: maskPng }),
      },
    }),
  );
  write(path.join(a.dir, 'api.png'), call.value.png); // resposta como veio, com o alfa original
  const decoded = await loadRgb(call.value.png);
  const sizeMismatch = decoded.width !== size.w || decoded.height !== size.h;
  const rawSent = sizeMismatch ? await resizeImg(decoded, size.w, size.h) : decoded;
  // Região de recomposição: A recuada em 40 px, sempre com S inteira (o preto do modelo na borda de A não entra).
  const region = union(erode(a.authorized, RECOMPOSE_INSET_PX), a.shape);
  const rec = await timed(latencyMs, 'recompose', async () => {
    const rawCrop = await resizeImg(rawSent, prep.box.w, prep.box.h);
    const out = await recompose(scene, rawCrop, prep.box, region, feather);
    verifyOutside(scene, out.final, region);
    return { rawCrop, out };
  });
  const m = await timed(latencyMs, 'metrics', async () => {
    const d = diffMetrics(prep.sent, rawSent, sShape, sAuth);
    const sweepF = await featherSweep(scene, rec.rawCrop, prep.box, region, FEATHER_SWEEP);
    return { d, sweepF, sweepT: tauSweep(prep.sent, rawSent, sShape, sAuth) };
  });
  const finalCrop = cropImg(rec.out.final, prep.box.x, prep.box.y, prep.box.w, prep.box.h);
  const files = {
    before: write(path.join(a.dir, 'before.png'), await imgToPng(prep.sent)),
    raw: write(path.join(a.dir, 'raw.png'), await imgToPng(rawSent)),
    final: write(path.join(a.dir, 'final.png'), await imgToPng(finalCrop)),
    mask: write(path.join(a.dir, `${a.arm}.png`), maskPng),
  };
  const origCrop = cropImg(scene, prep.box.x, prep.box.y, prep.box.w, prep.box.h);
  const marginDiffRatio = areaDiffRatio(
    origCrop,
    finalCrop,
    cropRaster(subtract(region, a.shape), prep.box),
  );
  const { outsideHistogram, ...diff } = m.d;
  return {
    final: rec.out.final,
    beforeSent: prep.sent,
    rawSent,
    sentAuth: sAuth,
    finalDefault: rec.out.final,
    plan: prep.plan,
    metrics: {
      ...diff,
      maskAreaRatio: shapeAreaRatio(a.shape),
      seamSsim: rec.out.seamSsim,
      marginDiffRatio,
    },
    outsideHistogram,
    featherSweep: m.sweepF,
    tauSweep: m.sweepT,
    sizeMismatch,
    costUsd: call.costUsd,
    requestId: call.requestId,
    latencyMs,
    files,
  };
}

export function sanityArea(shape: Raster): void {
  if (areaOf(shape) === 0) throw new Error('Forma vazia: a região marcada não cobre nenhum pixel');
}
