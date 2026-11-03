import * as fs from 'fs';
import * as path from 'path';
import type { Services } from './calls';
import { replicatePrice } from './config';
import { runEditStep } from './edit-core';
import type { EditOutcome, EditStepArgs } from './edit-core';
import { cropImg, imgToPng } from './image';
import type { Img } from './image';
import { dilate, subtract } from './morph';
import type { Box, Raster } from './morph';
import { runPaidCall } from './paid-call';
import { FILL_PROMPT, redrawPrompt, removePrompt, RETOUCH_PROMPT } from './prompts';
import { alphaCoverage, loadRgba, pasteRgba } from './rgba';
import type { Remover } from './remover';
import type { SceneCtx } from './scene-store';
import { authorizedRegion, marginPx, rasterizeRegion } from './shapes';
import type { PromotionCase, Rect } from './types';

export const RETOUCH_BANDS = [16, 32, 64];
export const FILL_DILATE_PX = 8;
const EMPTY_LOW = 0.02;
const EMPTY_HIGH = 0.98;

export interface StepSummary {
  costUsd: number;
  requestId: string | null;
  latencyMs: Record<string, number>;
  metrics: EditOutcome['metrics'];
  grown: boolean;
  downscaled: boolean;
  stretchFactor: number;
  insetScenePx: number;
  sizeMismatch: boolean;
  files: Record<string, string>;
}

export interface PromoResult {
  key: string;
  promoId: string;
  sceneId: string;
  target: string;
  atmospheric: boolean;
  destination: Rect;
  source: Rect;
  coverage: number;
  cutout: 'ok' | 'vazio';
  removeCostUsd: number;
  removeLatencyMs: number;
  fill?: StepSummary;
  paste?: { x: number; y: number };
  retouch: Array<StepSummary & { band: number; interiorPreserved: boolean }>;
  costUsd: number;
  files: Record<string, string>;
  dryRun: boolean;
}

export interface FallbackResult {
  key: string;
  promoId: string;
  sceneId: string;
  target: string;
  source: StepSummary;
  destination: StepSummary;
  costUsd: number;
  files: Record<string, string>;
  dryRun: boolean;
}

const summarize = (o: EditOutcome): StepSummary => ({
  costUsd: o.costUsd,
  requestId: o.requestId,
  latencyMs: o.latencyMs,
  metrics: o.metrics,
  grown: o.plan.grown,
  downscaled: o.plan.downscaled,
  stretchFactor: o.plan.stretchFactor,
  insetScenePx: o.insetScenePx,
  sizeMismatch: o.sizeMismatch,
  files: o.files,
});

const rectBox = (r: Rect, W: number, H: number): Box => ({
  x: Math.round(r.x * W),
  y: Math.round(r.y * H),
  w: Math.round(r.w * W),
  h: Math.round(r.h * H),
});

function expand(box: Box, pad: number, W: number, H: number): Box {
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return { x, y, w: Math.min(W, box.x + box.w + pad) - x, h: Math.min(H, box.y + box.h + pad) - y };
}

async function savePreview(img: Img, box: Box, file: string): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await imgToPng(cropImg(img, box.x, box.y, box.w, box.h)));
  return file;
}

export async function paidRemove(
  svc: Services,
  remover: Remover,
  caseId: string,
  png: Buffer,
): Promise<{ png: Buffer; costUsd: number; latencyMs: number }> {
  const price = replicatePrice(svc.prices);
  const spec = {
    kind: 'remove_bg' as const,
    caseId,
    block: 'B',
    step: 'remove_bg',
    provider: 'replicate' as const,
    endpoint: 'predictions',
    model: '851-labs/background-remover',
  };
  const r = await runPaidCall(svc.session.ctx, spec, async () => ({
    value: await remover.remove(png, caseId.replace(/[^A-Za-z0-9_-]/g, '_')),
    costUsd: price.perRunUsd,
    costEstimated: true,
  }));
  return { png: r.value, costUsd: r.costUsd, latencyMs: r.latencyMs };
}

/** Promoção a elemento: remoção de fundo, preenchimento, colagem e retoque da borda (varredura de faixas). */
export async function runPromotion(
  svc: Services,
  remover: Remover,
  scene: SceneCtx,
  promo: PromotionCase,
): Promise<PromoResult> {
  const { img } = scene;
  const key = `${promo.id}:promo`;
  const dir = path.join(svc.session.dir, 'cases', `${promo.id}_promo`);
  const src = promo.source!.region;
  const dst = promo.destination!;
  const srcBox = rectBox(src, img.width, img.height);
  const cutBox = expand(srcBox, marginPx(0.04, img.width, img.height), img.width, img.height);
  const srcPng = await imgToPng(cropImg(img, cutBox.x, cutBox.y, cutBox.w, cutBox.h));
  const removed = await paidRemove(svc, remover, key, srcPng);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'cutout.png'), removed.png);
  const cutout = await loadRgba(removed.png);
  const coverage = alphaCoverage(cutout);
  const base: PromoResult = {
    key,
    promoId: promo.id,
    sceneId: promo.sceneId,
    target: promo.target,
    atmospheric: promo.atmospheric,
    destination: dst,
    source: src,
    coverage,
    cutout: 'ok',
    removeCostUsd: removed.costUsd,
    removeLatencyMs: removed.latencyMs,
    retouch: [],
    costUsd: removed.costUsd,
    files: { cutout: path.join(dir, 'cutout.png') },
    dryRun: svc.session.dryRun,
  };
  if (coverage < EMPTY_LOW || coverage > EMPTY_HIGH) return { ...base, cutout: 'vazio' };
  const srcShape = await rasterizeRegion({ kind: 'rect', rect: src }, img.width, img.height);
  const fill = await runEditStep({
    svc,
    caseId: key,
    block: 'B',
    step: 'fill',
    scene: img,
    shape: srcShape,
    authorized: dilate(srcShape, FILL_DILATE_PX),
    prompt: FILL_PROMPT,
    arm: 'mask',
    dir: path.join(dir, 'fill'),
  });
  const cx = Math.round((dst.x + dst.w / 2) * img.width);
  const cy = Math.round((dst.y + dst.h / 2) * img.height);
  const x = Math.round(cx - cutout.width / 2);
  const y = Math.round(cy - cutout.height / 2);
  if (x < 0 || y < 0 || x + cutout.width > img.width || y + cutout.height > img.height) {
    throw new Error('paste_out_of_bounds: a marcação do destino leva o recorte para fora da cena');
  }
  const pasted = pasteRgba(fill.final, cutout, x, y);
  const view = expand(
    rectBox(dst, img.width, img.height),
    Math.round(0.15 * img.width * dst.w) + 32,
    img.width,
    img.height,
  );
  const files: Record<string, string> = {
    ...base.files,
    before: await savePreview(img, view, path.join(dir, 'before.png')),
    pasted: await savePreview(pasted.image, view, path.join(dir, 'pasted.png')),
  };
  const retouch: PromoResult['retouch'] = [];
  for (const band of RETOUCH_BANDS) {
    const ring: Raster = subtract(dilate(pasted.object, band), pasted.interior);
    const out = await runEditStep({
      svc,
      caseId: key,
      block: 'B',
      step: `retouch_${band}`,
      scene: pasted.image,
      shape: ring,
      authorized: ring,
      prompt: RETOUCH_PROMPT,
      arm: 'mask',
      dir: path.join(dir, `retouch_${band}`),
    });
    let preserved = true;
    for (let i = 0; i < pasted.interior.data.length && preserved; i += 1) {
      if (!pasted.interior.data[i]) continue;
      for (let c = 0; c < 3; c += 1)
        if (out.final.data[i * 3 + c] !== pasted.image.data[i * 3 + c]) preserved = false;
    }
    retouch.push({ ...summarize(out), band, interiorPreserved: preserved });
    if (band === 32) files.final = await savePreview(out.final, view, path.join(dir, 'final.png'));
  }
  const costUsd = removed.costUsd + fill.costUsd + retouch.reduce((s, r) => s + r.costUsd, 0);
  return { ...base, fill: summarize(fill), paste: { x, y }, retouch, costUsd, files };
}

/** Fallback: repintura mascarada da origem (remover) e do destino (desenhar com a origem de referência). */
export async function runFallback(
  svc: Services,
  scene: SceneCtx,
  promo: PromotionCase,
  offline?: { source: EditStepArgs['offline']; destination: EditStepArgs['offline'] },
): Promise<FallbackResult> {
  const { img } = scene;
  const key = `${promo.id}:fallback`;
  const dir = path.join(svc.session.dir, 'cases', `${promo.id}_fallback`);
  const src = promo.source!.region;
  const dst = promo.destination!;
  const margin = marginPx(0.04, img.width, img.height);
  const srcShape = await rasterizeRegion({ kind: 'rect', rect: src }, img.width, img.height);
  const dstShape = await rasterizeRegion({ kind: 'rect', rect: dst }, img.width, img.height);
  const srcBox = expand(rectBox(src, img.width, img.height), margin, img.width, img.height);
  const reference = await imgToPng(cropImg(img, srcBox.x, srcBox.y, srcBox.w, srcBox.h));
  const first = await runEditStep({
    svc,
    caseId: key,
    block: 'B',
    step: 'fallback_source',
    scene: img,
    shape: srcShape,
    authorized: authorizedRegion(srcShape, margin),
    prompt: removePrompt(promo.target),
    arm: 'mask',
    dir: path.join(dir, 'source'),
    offline: offline?.source,
  });
  const second = await runEditStep({
    svc,
    caseId: key,
    block: 'B',
    step: 'fallback_destination',
    scene: first.final,
    shape: dstShape,
    authorized: authorizedRegion(dstShape, margin),
    prompt: redrawPrompt(promo.target),
    arm: 'mask',
    dir: path.join(dir, 'destination'),
    reference,
    offline: offline?.destination,
  });
  const view = expand(
    rectBox(dst, img.width, img.height),
    Math.round(0.15 * img.width * dst.w) + 32,
    img.width,
    img.height,
  );
  const files = {
    before: await savePreview(img, view, path.join(dir, 'before.png')),
    raw: second.files.raw,
    final: await savePreview(second.final, view, path.join(dir, 'final.png')),
  };
  return {
    key,
    promoId: promo.id,
    sceneId: promo.sceneId,
    target: promo.target,
    source: summarize(first),
    destination: summarize(second),
    costUsd: first.costUsd + second.costUsd,
    files,
    dryRun: svc.session.dryRun,
  };
}
