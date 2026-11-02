import * as fs from 'fs';
import * as path from 'path';
import { darkRatio } from './compare';
import { computeCrop } from './crop';
import { RECOMPOSE_INSET_PX } from './edit-core';
import { editJobs, specOf } from './edit-jobs';
import { loadCases } from './plan';
import { SceneStore } from './scene-store';
import { marginPx } from './shapes';
import { Drill } from './drill-util';
import { syntheticScene } from './fake-openai';
import { cropImg, loadRgb, resizeImg } from './image';
import type { Img } from './image';
import { diffMetrics, FEATHER_SWEEP, tauSweep } from './metrics';
import { bboxOf, cropRaster, erode, union } from './morph';
import type { Box, Raster } from './morph';
import {
  featherAlpha,
  featherSweep,
  recompose,
  RecomposeMismatchError,
  verifyOutside,
} from './recompose';
import { authorizedRegion, rasterizeRegion } from './shapes';

const W = 1280;
const H = 1280;
const BOX: Box = { x: 200, y: 200, w: 880, h: 880 };

interface Fixture {
  original: Img;
  before: Img;
  shape: Raster;
  authorized: Raster;
  shapeCrop: Raster;
  authorizedCrop: Raster;
}

async function fixture(): Promise<Fixture> {
  const original = await loadRgb(await syntheticScene(W, H, 3));
  const shape = await rasterizeRegion(
    { kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } },
    W,
    H,
  );
  const authorized = authorizedRegion(shape, 40);
  return {
    original,
    before: cropImg(original, BOX.x, BOX.y, BOX.w, BOX.h),
    shape,
    authorized,
    shapeCrop: cropRaster(shape, BOX),
    authorizedCrop: cropRaster(authorized, BOX),
  };
}

function brighten(img: Img, only?: Raster, amount = 60): Img {
  const data = img.data.slice();
  for (let i = 0; i < img.width * img.height; i += 1) {
    if (only && !only.data[i]) continue;
    for (let c = 0; c < 3; c += 1) data[i * 3 + c] = Math.min(255, data[i * 3 + c] + amount);
  }
  return { ...img, data };
}

async function identical(d: Drill, f: Fixture): Promise<void> {
  d.section('Saída idêntica ao recorte ("não fez nada")');
  const m = diffMetrics(f.before, f.before, f.shapeCrop, f.authorizedCrop);
  d.check(
    'insideMaskDiffRatio = 0 (abaixo de qualquer limiar candidato)',
    m.insideMaskDiffRatio === 0 && m.insideMaskDiffRatio < 0.02,
  );
  d.check('outsideMaskDiffRatio = 0', m.outsideMaskDiffRatio === 0);
  const r = await recompose(f.original, f.before, BOX, f.authorized, 24);
  verifyOutside(f.original, r.final, f.authorized);
  d.check(
    'final idêntico ao original (saída = recorte)',
    Buffer.compare(Buffer.from(r.final.data), Buffer.from(f.original.data)) === 0,
  );
  d.check(
    'seamSsim = 1 quando bruta = final',
    r.seamSsim !== null && r.seamSsim > 0.999,
    String(r.seamSsim),
  );
}

async function exteriorChanged(d: Drill, f: Fixture): Promise<void> {
  d.section('Saída que altera o exterior da região');
  const raw = brighten(f.before);
  const m = diffMetrics(f.before, raw, f.shapeCrop, f.authorizedCrop);
  d.check(
    'outsideMaskDiffRatio da bruta fica registrado (> 0,9)',
    m.outsideMaskDiffRatio > 0.9,
    m.outsideMaskDiffRatio.toFixed(3),
  );
  d.check('insideMaskDiffRatio > 0,9', m.insideMaskDiffRatio > 0.9);
  d.check(
    'histograma fora de A soma os pixels fora de A',
    m.outsideHistogram.reduce((a, b) => a + b, 0) === m.pixelsOutside,
  );
  const r = await recompose(f.original, raw, BOX, f.authorized, 24);
  verifyOutside(f.original, r.final, f.authorized);
  d.check(
    'final idêntico ao original fora de A (byte a byte)',
    r.final.data[(10 * W + 10) * 3] === f.original.data[(10 * W + 10) * 3],
  );
  d.check(
    'dentro de S o final segue a saída bruta',
    r.final.data[(640 * W + 640) * 3] === raw.data[((640 - BOX.y) * BOX.w + (640 - BOX.x)) * 3],
  );
  d.check(
    'seamSsim calculado na faixa de transição',
    r.seamSsim !== null && r.seamSsim < 1,
    String(r.seamSsim),
  );
  const edit = brighten(f.before, f.shapeCrop);
  const e = diffMetrics(f.before, edit, f.shapeCrop, f.authorizedCrop);
  d.check(
    'edição só dentro de S: outside = 0 e inside > 0,9',
    e.outsideMaskDiffRatio === 0 && e.insideMaskDiffRatio > 0.9,
  );
}

async function forcedError(d: Drill, f: Fixture): Promise<void> {
  d.section('Erro forçado na recomposição');
  const r = await recompose(f.original, brighten(f.before), BOX, f.authorized, 24);
  const bad = { ...r.final, data: r.final.data.slice() };
  bad.data[(10 * W + 10) * 3] ^= 0xff;
  await d.rejects(
    'um pixel diferente fora de A falha com recompose_mismatch',
    () => verifyOutside(f.original, bad, f.authorized),
    (e) =>
      e instanceof RecomposeMismatchError && e.code === 'recompose_mismatch' && e.mismatched === 1,
  );
}

async function sweeps(d: Drill, f: Fixture): Promise<void> {
  d.section('Varreduras offline de feather e τ, e forma do α');
  const alpha = await featherAlpha(f.authorized, BOX, 24);
  const at = (x: number, y: number): number => alpha[(y - BOX.y) * BOX.w + (x - BOX.x)];
  d.check(
    'α = 0 fora de A, 255 no miolo e intermediário na borda',
    at(210, 210) === 0 && at(640, 640) === 255 && alpha.some((a) => a > 0 && a < 255),
  );
  const fs = await featherSweep(f.original, brighten(f.before), BOX, f.authorized, FEATHER_SWEEP);
  d.check(
    'varredura de feather devolve seamSsim para 8, 16, 24, 32 e 48',
    fs.map((x) => x.feather).join() === '8,16,24,32,48' && fs.every((x) => x.seamSsim !== null),
  );
  const taus = tauSweep(
    f.before,
    brighten(f.before, f.shapeCrop, 20),
    f.shapeCrop,
    f.authorizedCrop,
  );
  d.check(
    'varredura de τ: o diff interno cai quando τ sobe',
    taus[0].insideMaskDiffRatio >= taus[taus.length - 1].insideMaskDiffRatio,
  );
}

async function inset(d: Drill, f: Fixture): Promise<void> {
  d.section('Recuo de 40 px da região de recomposição (preto do modelo na borda de A)');
  // saída bruta: edição em A, com uma faixa preta de 27 px dentro da borda de A e preto fora de A
  const raw = brighten(f.before);
  const inner = erode(f.authorized, 27);
  for (let y = 0; y < BOX.h; y += 1) {
    for (let x = 0; x < BOX.w; x += 1) {
      const sx = x + BOX.x;
      const sy = y + BOX.y;
      const i = sy * W + sx;
      const band = f.authorized.data[i] && !inner.data[i];
      if (!f.authorized.data[i] || band)
        raw.data.fill(0, (y * BOX.w + x) * 3, (y * BOX.w + x) * 3 + 3);
    }
  }
  const plain = await recompose(f.original, raw, BOX, f.authorized, 24);
  const region = union(erode(f.authorized, RECOMPOSE_INSET_PX), f.shape);
  const cut = await recompose(f.original, raw, BOX, region, 24);
  verifyOutside(f.original, cut.final, region);
  d.check(
    'sem recuo a faixa preta aparece no final',
    darkRatio(f.original, plain.final, f.authorized) > 0.02,
  );
  d.check(
    'com recuo de 40 px a faixa preta some',
    darkRatio(f.original, cut.final, f.authorized) === 0,
  );
  const sHit = f.shape.data.every((v, i) => !v || region.data[i]);
  d.check('S continua inteira dentro da região de recomposição', sHit);
  const real = path.resolve(__dirname, '../out/template-scene-spike/compare/A01/M3/raw.png');
  d.check(
    'saída bruta real do A01 (M3): recuo elimina a faixa (se o arquivo existir)',
    await realA01(real),
  );
}

async function realA01(file: string): Promise<boolean> {
  if (!fs.existsSync(file)) return true;
  const cases = loadCases();
  const job = editJobs(cases).a.find((j) => j.edit.id === 'A01' && j.arm === 'mask')!;
  const sc = await new SceneStore(
    path.resolve(__dirname, '../out/template-scene-spike'),
    cases,
  ).get('C1');
  const shape = await rasterizeRegion(specOf(job), sc.img.width, sc.img.height, sc.format);
  const auth = authorizedRegion(shape, marginPx(0.04, sc.img.width, sc.img.height));
  const box = computeCrop(sc.img.width, sc.img.height, bboxOf(auth) as Box).box;
  const raw = await resizeImg(await loadRgb(fs.readFileSync(file)), box.w, box.h);
  const before = darkRatio(sc.img, (await recompose(sc.img, raw, box, auth, 24)).final, auth);
  const region = union(erode(auth, RECOMPOSE_INSET_PX), shape);
  const after = darkRatio(sc.img, (await recompose(sc.img, raw, box, region, 24)).final, region);
  return before > 0.02 && after === 0;
}

export async function runMetricDrills(d: Drill): Promise<void> {
  const f = await fixture();
  await identical(d, f);
  await exteriorChanged(d, f);
  await forcedError(d, f);
  await sweeps(d, f);
  await inset(d, f);
}
