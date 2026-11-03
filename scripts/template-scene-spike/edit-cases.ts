import * as fs from 'fs';
import * as path from 'path';
import { runEditStep } from './edit-core';
import type { EditStepArgs } from './edit-core';
import { insetOnScene } from './edit-core';
import { specOf } from './edit-jobs';
import type { EditJob } from './edit-jobs';
import type { Services } from './calls';
import { cropImg, loadRgb } from './image';
import { areaDiffRatio } from './metrics-extra';
import { cropRaster, intersect, resizeRaster, subtract } from './morph';
import type { Raster } from './morph';
import { editPrompt } from './prompts';
import { authorizedRegion, marginPx, rasterizeRegion, zoneRect } from './shapes';
import type { SceneCtx } from './scene-store';
import type { Rect } from './types';

export interface NeighborLeak {
  rawDiffRatio: number;
  finalDiffRatio: number;
  areaPx: number;
}

export interface EditResult {
  key: string;
  block: string;
  sceneId: string;
  mechanism: 'mask' | 'markup';
  variant: string;
  prompt: string;
  request: string;
  region: Rect;
  mask?: unknown;
  marginFraction: number;
  marginPx: number;
  grown: boolean;
  downscaled: boolean;
  belowMinArea: boolean;
  stretchFactor: number;
  insetScenePx: number;
  sizeMismatch: boolean;
  metrics: Awaited<ReturnType<typeof runEditStep>>['metrics'];
  outsideHistogram: number[];
  featherSweep: Awaited<ReturnType<typeof runEditStep>>['featherSweep'];
  tauSweep: Awaited<ReturnType<typeof runEditStep>>['tauSweep'];
  neighbor?: NeighborLeak;
  costUsd: number;
  requestId: string | null;
  latencyMs: Record<string, number>;
  files: Record<string, string>;
  dryRun: boolean;
}

async function leakage(
  job: EditJob,
  scene: SceneCtx,
  shape: Raster,
  out: Awaited<ReturnType<typeof runEditStep>>,
): Promise<NeighborLeak | undefined> {
  const e = job.edit;
  if (!e.neighbor || !e.region) return undefined;
  const { img } = scene;
  const rectRaster = await rasterizeRegion({ kind: 'rect', rect: e.region }, img.width, img.height);
  const nb = await rasterizeRegion({ kind: 'rect', rect: e.neighbor }, img.width, img.height);
  const shapeRaster = e.mask ? await rasterizeRegion(e.mask, img.width, img.height) : shape;
  const area = subtract(intersect(nb, rectRaster), shapeRaster);
  const { box } = out.plan;
  const finalCrop = cropImg(out.final, box.x, box.y, box.w, box.h);
  const orig = cropImg(img, box.x, box.y, box.w, box.h);
  const before = await loadRgb(fs.readFileSync(out.files.before));
  const raw = await loadRgb(fs.readFileSync(out.files.raw));
  const areaCrop = cropRaster(area, box);
  const areaSent = resizeRaster(areaCrop, before.width, before.height);
  // A vizinha pode passar do recorte; o que está fora dele não muda, então a razão é sobre a área inteira.
  const fullPx = countSet(area);
  const cropPx = countSet(areaCrop);
  const scale = fullPx ? cropPx / fullPx : 0;
  return {
    rawDiffRatio: areaDiffRatio(before, raw, areaSent) * scale,
    finalDiffRatio: areaDiffRatio(orig, finalCrop, areaCrop) * scale,
    areaPx: fullPx,
  };
}

const countSet = (r: Raster): number => r.data.reduce((n, v) => n + (v ? 1 : 0), 0);

/** Executa um job dos blocos A ou C e devolve o resultado (grava as imagens em `cases/<chave>/`). */
export async function runEditJob(
  svc: Services,
  scene: SceneCtx,
  job: EditJob,
  offline?: EditStepArgs['offline'],
): Promise<EditResult> {
  const { img } = scene;
  const e = job.edit;
  const shape = await rasterizeRegion(specOf(job), img.width, img.height, scene.format);
  const margin = marginPx(job.marginFraction, img.width, img.height);
  const authorized = authorizedRegion(shape, margin);
  const dir = path.join(svc.session.dir, 'cases', job.key.replace(/[^A-Za-z0-9_.-]/g, '_'));
  const out = await runEditStep({
    svc,
    caseId: job.key,
    block: job.block,
    step: 'edit',
    scene: img,
    shape,
    authorized,
    prompt: editPrompt(e.prompt, job.arm),
    arm: job.arm,
    dir,
    offline,
  });
  const neighbor = job.block === 'C' ? await leakage(job, scene, shape, out) : undefined;
  return {
    key: job.key,
    block: job.block,
    sceneId: e.sceneId,
    mechanism: job.arm,
    variant: job.variant,
    prompt: editPrompt(e.prompt, job.arm),
    request: e.prompt,
    region: e.region ?? zoneRect(e.zone ?? 'header', scene.format),
    mask: job.variant === 'rect' ? undefined : e.mask,
    marginFraction: job.marginFraction,
    marginPx: margin,
    grown: out.plan.grown,
    downscaled: out.plan.downscaled,
    belowMinArea: out.plan.belowMinArea,
    stretchFactor: out.plan.stretchFactor,
    insetScenePx: insetOnScene(out.plan.scale),
    sizeMismatch: out.sizeMismatch,
    metrics: out.metrics,
    outsideHistogram: out.outsideHistogram,
    featherSweep: out.featherSweep,
    tauSweep: out.tauSweep,
    neighbor,
    costUsd: out.costUsd,
    requestId: out.requestId,
    latencyMs: out.latencyMs,
    files: out.files,
    dryRun: svc.session.dryRun,
  };
}
