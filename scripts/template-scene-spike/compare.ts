import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import type { Services } from './calls';
import { computeCrop } from './crop';
import { makeStrip } from './compare-strip';
import type { Panel } from './compare-strip';
import { runEditStep } from './edit-core';
import type { EditOutcome } from './edit-core';
import { editJobs, specOf } from './edit-jobs';
import { cropImg, imgToPng, lumaOf, resizeImg } from './image';
import type { Img } from './image';
import { bboxOf } from './morph';
import type { Box, Raster } from './morph';
import { editPrompt } from './prompts';
import { recompose } from './recompose';
import { SceneStore } from './scene-store';
import { StopError } from './budget';
import { authorizedRegion, marginPx, rasterizeRegion } from './shapes';
import { say } from './runner';
import type { CasesFile } from './types';

export const COMPARE_CASES = ['A01', 'A02', 'A11', 'A05'];
export const COMPARE_BUDGET_USD = 5;
const WIDE_FEATHER = 64;

interface Mechanism {
  id: string;
  name: string;
  arm: 'mask' | 'markup';
  plain?: boolean;
  variant: NonNullable<Parameters<typeof runEditStep>[0]['variant']>;
}

export const MECHANISMS: Mechanism[] = [
  {
    id: 'M1',
    name: 'multipart alfa0 recorte',
    arm: 'mask',
    variant: { transport: 'multipart', maskEditAlpha: 0, maskRgbFromImage: true, track: false },
  },
  {
    id: 'M2',
    name: 'multipart alfa0 inteira',
    arm: 'mask',
    variant: {
      transport: 'multipart',
      maskEditAlpha: 0,
      maskRgbFromImage: true,
      whole: true,
      track: false,
    },
  },
  {
    id: 'M3',
    name: 'JSON alfa255 recorte',
    arm: 'mask',
    variant: { maskEditAlpha: 255, track: false },
  },
  { id: 'M4', name: 'markup recorte', arm: 'markup', variant: { track: false } },
  { id: 'M5', name: 'markup inteira', arm: 'markup', variant: { whole: true, track: false } },
  {
    id: 'M6',
    name: 'sem máscara inteira',
    arm: 'mask',
    plain: true,
    variant: { transport: 'multipart', whole: true, noMask: true, track: false },
  },
];

export interface CompareResult {
  caseId: string;
  mech: string;
  name: string;
  ok: boolean;
  error?: string;
  metrics?: EditOutcome['metrics'] & {
    blackOutsideRatio: number;
    blackInsideRatio: number;
    finalDarkRatio: number;
    finalDarkRatioWide: number;
  };
  costUsd?: number;
  providerMs?: number;
  requestId?: string | null;
  dir: string;
}

const peak = (d: Uint8Array, i: number): number => Math.max(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);

/** Preto introduzido pelo modelo: pixel que era claro e voltou ≤ 8, dentro e fora da região autorizada. */
export function blackRatios(
  before: Img,
  raw: Img,
  auth: Raster,
): { inside: number; outside: number } {
  let inN = 0;
  let inB = 0;
  let outN = 0;
  let outB = 0;
  for (let i = 0; i < auth.data.length; i += 1) {
    const black = peak(raw.data, i) <= 8 && peak(before.data, i) > 40;
    if (auth.data[i]) {
      inN += 1;
      if (black) inB += 1;
    } else {
      outN += 1;
      if (black) outB += 1;
    }
  }
  return { inside: inN ? inB / inN : 0, outside: outN ? outB / outN : 0 };
}

/** Faixa escura no final: pixel de A cuja luma caiu para menos da metade do original (original claro). */
export function darkRatio(original: Img, final: Img, auth: Raster): number {
  const a = lumaOf(original);
  const b = lumaOf(final);
  let n = 0;
  let dark = 0;
  for (let i = 0; i < auth.data.length; i += 1) {
    if (!auth.data[i]) continue;
    n += 1;
    if (a[i] > 40 && b[i] < a[i] * 0.5) dark += 1;
  }
  return n ? dark / n : 0;
}

async function windowPng(file: string, whole: boolean, box: Box): Promise<Buffer> {
  const img = sharp(file);
  return whole
    ? img.extract({ left: box.x, top: box.y, width: box.w, height: box.h }).png().toBuffer()
    : img.resize(box.w, box.h, { fit: 'fill' }).png().toBuffer();
}

async function runOne(
  svc: Services,
  scene: Img,
  caseId: string,
  m: Mechanism,
  dir: string,
  spec: Parameters<typeof rasterizeRegion>[0],
  format: Parameters<typeof rasterizeRegion>[3],
  request: string,
): Promise<CompareResult> {
  const base = { caseId, mech: m.id, name: m.name, dir };
  const shape = await rasterizeRegion(spec, scene.width, scene.height, format);
  const authorized = authorizedRegion(shape, marginPx(0.04, scene.width, scene.height));
  const prompt = m.plain
    ? `${request}. Preserve o restante da imagem exatamente como está.`
    : editPrompt(request, m.arm);
  try {
    const out = await runEditStep({
      svc,
      caseId: `${caseId}:${m.id}`,
      block: 'CMP',
      step: 'edit',
      scene,
      shape,
      authorized,
      prompt,
      arm: m.arm,
      dir,
      variant: m.variant,
    });
    const black = blackRatios(out.beforeSent, out.rawSent, out.sentAuth);
    const { box } = out.plan;
    const rawCrop = await resizeImg(out.rawSent, box.w, box.h);
    const wide = await recompose(scene, rawCrop, box, authorized, WIDE_FEATHER);
    fs.writeFileSync(
      path.join(dir, 'final_f64.png'),
      await imgToPng(cropImg(wide.final, box.x, box.y, box.w, box.h)),
    );
    return {
      ...base,
      ok: true,
      costUsd: out.costUsd,
      providerMs: out.latencyMs.provider,
      requestId: out.requestId,
      metrics: {
        ...out.metrics,
        blackOutsideRatio: black.outside,
        blackInsideRatio: black.inside,
        finalDarkRatio: darkRatio(scene, out.final, authorized),
        finalDarkRatioWide: darkRatio(scene, wide.final, authorized),
      },
    };
  } catch (err) {
    if (err instanceof StopError) throw err;
    return { ...base, ok: false, error: (err as Error).message.slice(0, 300) };
  }
}

async function strips(
  scene: Img,
  caseId: string,
  outDir: string,
  view: Box,
  results: CompareResult[],
): Promise<void> {
  const before = await imgToPng(cropImg(scene, view.x, view.y, view.w, view.h));
  const build = async (kind: 'final' | 'raw' | 'final_f64'): Promise<Panel[]> => {
    const panels: Panel[] = [
      { label: [`${caseId} antes`, '(recorte de referência)'], png: before },
    ];
    for (const r of results) {
      const whole = ['M2', 'M5', 'M6'].includes(r.mech);
      const file = path.join(r.dir, `${kind}.png`);
      const m = r.metrics;
      const label = [
        `${r.mech} ${r.name}`,
        r.ok
          ? `in ${m!.insideMaskDiffRatio.toFixed(2)} seam ${(m!.seamSsim ?? 0).toFixed(2)}`
          : 'RECUSADA/ERRO',
        r.ok
          ? `preto fora ${m!.blackOutsideRatio.toFixed(2)} faixa ${m!.finalDarkRatio.toFixed(3)}`
          : (r.error ?? '').slice(0, 40),
      ];
      if (!r.ok || !fs.existsSync(file)) {
        panels.push({
          label,
          png: await sharp({ create: { width: 200, height: 200, channels: 3, background: '#400' } })
            .png()
            .toBuffer(),
        });
        continue;
      }
      panels.push({ label, png: await windowPng(file, whole, view) });
    }
    return panels;
  };
  for (const kind of ['final', 'raw', 'final_f64'] as const)
    await makeStrip(await build(kind), path.join(outDir, `strip_${kind}.png`));
}

/** Comparação lado a lado de 6 mecanismos de edição em 4 pedidos (sub-orçamento de US$ 5). */
export async function runCompare(svc: Services, cases: CasesFile, only?: string): Promise<void> {
  const scenes = new SceneStore(svc.session.dir, cases);
  const root = path.join(svc.session.dir, 'compare');
  const jobs = editJobs(cases).a.filter(
    (j) => j.arm === 'mask' && COMPARE_CASES.includes(j.edit.id) && (!only || j.edit.id === only),
  );
  const start = svc.session.budget.spentUsd();
  const all: CompareResult[] = [];
  for (const job of jobs) {
    const e = job.edit;
    const scene = await scenes.get(e.sceneId);
    const caseDir = path.join(root, e.id);
    const results: CompareResult[] = [];
    for (const m of MECHANISMS) {
      const dir = path.join(caseDir, m.id);
      const cache = path.join(dir, 'result.json');
      if (fs.existsSync(cache) && !only) {
        results.push(JSON.parse(fs.readFileSync(cache, 'utf8')) as CompareResult);
        continue;
      }
      if (svc.session.budget.spentUsd() - start > COMPARE_BUDGET_USD - 0.5)
        throw new StopError(
          'budget',
          `Sub-orçamento da comparação (US$ ${COMPARE_BUDGET_USD}) perto do fim`,
        );
      fs.mkdirSync(dir, { recursive: true });
      const r = await runOne(svc, scene.img, e.id, m, dir, specOf(job), scene.format, e.prompt);
      fs.writeFileSync(cache, JSON.stringify(r, null, 2));
      say(
        `  ${e.id} ${m.id} ${r.ok ? `ok US$ ${(r.costUsd ?? 0).toFixed(4)} inside ${r.metrics!.insideMaskDiffRatio.toFixed(2)}` : `ERRO ${r.error}`}`,
      );
      results.push(r);
    }
    const shape = await rasterizeRegion(
      specOf(job),
      scene.img.width,
      scene.img.height,
      scene.format,
    );
    const auth = authorizedRegion(shape, marginPx(0.04, scene.img.width, scene.img.height));
    const view = computeCrop(scene.img.width, scene.img.height, bboxOf(auth)!).box;
    await strips(scene.img, e.id, caseDir, view, results);
    all.push(...results);
  }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(all, null, 2));
  say(
    `Comparação: ${all.filter((r) => r.ok).length}/${all.length} chamadas ok; gasto da comparação US$ ${(svc.session.budget.spentUsd() - start).toFixed(4)}; tiras em ${root}`,
  );
}
