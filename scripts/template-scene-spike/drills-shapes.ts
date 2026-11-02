import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';
import { computeCrop, MAX_STRETCH } from './crop';
import { Drill, drillDir } from './drill-util';
import { syntheticScene } from './fake-openai';
import { FORMATS, MIN_AREA } from './formats';
import { areaOf, bboxOf, cropRaster } from './morph';
import type { Box } from './morph';
import {
  authorizedRegion,
  marginPx,
  rasterizeRegion,
  renderEditMask,
  renderMarkup,
  zoneRect,
} from './shapes';
import type { Rect } from './types';

function contains(outer: Box, inner: Box): boolean {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w &&
    outer.y + outer.h >= inner.y + inner.h
  );
}

async function alphaAt(png: Buffer, x: number, y: number): Promise<number> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
}

/** Recorta, grava as máscaras PNG para inspeção e confere as regras do recorte. */
async function runCase(
  d: Drill,
  dir: string,
  name: string,
  W: number,
  H: number,
  rect: Rect | 'header',
) {
  const spec =
    rect === 'header'
      ? ({ kind: 'zone', zone: 'header' } as const)
      : ({ kind: 'rect', rect } as const);
  const shape = await rasterizeRegion(spec, W, H, FORMATS['folheto-55x36']);
  const authorized = authorizedRegion(shape, marginPx(0.04, W, H));
  const bbox = bboxOf(authorized) as Box;
  const plan = computeCrop(W, H, bbox);
  const { box } = plan;
  d.check(
    `${name}: lados múltiplos de 16, dentro da imagem, contém A`,
    box.w % 16 === 0 &&
      box.h % 16 === 0 &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.w <= W &&
      box.y + box.h <= H &&
      contains(box, bbox),
  );
  d.check(
    `${name}: enviado ≤ 1024 por lado e ≥ 655.360 px`,
    plan.sendW <= 1024 && plan.sendH <= 1024 && plan.sendW * plan.sendH >= MIN_AREA,
    `${plan.sendW}x${plan.sendH}`,
  );
  const size = { w: plan.sendW, h: plan.sendH };
  const maskPng = await renderEditMask(cropRaster(authorized, box), size);
  const markupPng = await renderMarkup(cropRaster(shape, box), size);
  fs.writeFileSync(path.join(dir, `${name}-mask.png`), maskPng);
  fs.writeFileSync(path.join(dir, `${name}-markup.png`), markupPng);
  const scene = await syntheticScene(W, H, name.length);
  await sharp(scene)
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .png()
    .toFile(path.join(dir, `${name}-crop.png`));
  process.stdout.write(
    `    ${name}: crop ${box.w}x${box.h} em (${box.x},${box.y}), enviado ${plan.sendW}x${plan.sendH}, grown=${plan.grown}, downscaled=${plan.downscaled}\n`,
  );
  return { plan, shape, authorized, box, maskPng, markupPng, size };
}

async function cropCases(d: Drill): Promise<void> {
  d.section('Edição local por recorte: região pequena, grande e normal');
  const dir = drillDir('shapes');
  const small = await runCase(d, dir, 'pequena-3pct', 1920, 3840, {
    x: 0.4,
    y: 0.4,
    w: 0.03,
    h: 0.03,
  });
  d.check(
    'região pequena: grown=true, downscaled=false',
    small.plan.grown && !small.plan.downscaled,
  );
  const big = await runCase(d, dir, 'cabecalho-C2', 3520, 2336, 'header');
  d.check('região grande: downscaled=true', big.plan.downscaled);
  const rug = await runCase(d, dir, 'tapete-C5', 3840, 2128, {
    x: 0.06,
    y: 0.715,
    w: 0.91,
    h: 0.16,
  });
  d.check(
    'imagem baixa: tamanho enviado esticado até 655.360 px',
    rug.plan.stretched && rug.plan.sendW * rug.plan.sendH >= MIN_AREA && !rug.plan.belowMinArea,
  );
  const tall = await runCase(d, dir, 'tapete-retrato', 2128, 3840, {
    x: 0.715,
    y: 0.06,
    w: 0.16,
    h: 0.91,
  });
  d.check(
    'retrato alto: estica a LARGURA (lado menor), com fator ≤ teto',
    tall.plan.stretched &&
      tall.plan.sendW < tall.plan.sendH &&
      tall.plan.stretchFactor <= MAX_STRETCH,
    String(tall.plan.stretchFactor.toFixed(3)),
  );
  const low = await runCase(d, dir, 'paisagem-baixa', 3840, 2128, {
    x: 0.06,
    y: 0.715,
    w: 0.91,
    h: 0.16,
  });
  d.check(
    'paisagem baixa: estica a ALTURA (lado menor), com fator ≤ teto',
    low.plan.stretched && low.plan.sendH < low.plan.sendW && low.plan.stretchFactor <= MAX_STRETCH,
    String(low.plan.stretchFactor.toFixed(3)),
  );
  const thin = computeCrop(3840, 1200, { x: 0, y: 400, w: 3840, h: 120 });
  d.check(
    'acima do teto de distorção: não estica, fica belowMinArea',
    !thin.stretched && thin.belowMinArea && thin.stretchFactor === 1,
    `${thin.sendW}x${thin.sendH}`,
  );
  const normal = await runCase(d, dir, 'normal', 1920, 3840, { x: 0.3, y: 0.3, w: 0.4, h: 0.2 });
  d.check('região média: sem crescer nem reduzir', !normal.plan.grown && !normal.plan.downscaled);
  const corner = await runCase(d, dir, 'canto', 1920, 3840, { x: 0, y: 0, w: 0.02, h: 0.01 });
  d.check('região no canto: recorte preso à imagem', corner.box.x === 0 && corner.box.y === 0);
  d.check(
    'máscara de edição: alfa 255 (editar) dentro de A e 0 fora',
    (await alphaAt(small.maskPng, small.size.w / 2, small.size.h / 2)) === 255 &&
      (await alphaAt(small.maskPng, 2, 2)) === 0,
  );
  d.check(
    'markup: opaco no contorno, transparente fora',
    (await alphaAt(small.markupPng, 2, 2)) === 0,
  );
}

async function shapeCases(d: Drill): Promise<void> {
  d.section('Rasterização: retângulo, pincel, laço e zona');
  const W = 1000;
  const H = 1000;
  const rect = await rasterizeRegion(
    { kind: 'rect', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 } },
    W,
    H,
  );
  d.check('retângulo: área exata', areaOf(rect) === 200 * 300);
  const triangle = await rasterizeRegion(
    {
      kind: 'lasso',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    },
    W,
    H,
  );
  d.check(
    'laço: triângulo = metade da imagem (±1%)',
    Math.abs(areaOf(triangle) / (W * H) - 0.5) < 0.01,
  );
  const radius = 0.05;
  const brush = await rasterizeRegion(
    {
      kind: 'brush',
      radius,
      strokes: [
        [
          { x: 0.2, y: 0.5 },
          { x: 0.8, y: 0.5 },
        ],
      ],
    },
    W,
    H,
  );
  const expected = 600 * 100 + Math.PI * 50 * 50;
  d.check(
    'pincel: traço com pontas redondas (±3%)',
    Math.abs(areaOf(brush) - expected) / expected < 0.03,
    String(areaOf(brush)),
  );
  const dot = await rasterizeRegion(
    { kind: 'brush', radius, strokes: [[{ x: 0.5, y: 0.5 }]] },
    W,
    H,
  );
  d.check('pincel de um ponto vira círculo', areaOf(dot) > 0.9 * Math.PI * 50 * 50);
  const format = FORMATS['folheto-27x54'];
  const zone = zoneRect('header', format);
  d.check(
    'zona cabeçalho: 6 cm de 55 cm, largura total',
    zone.w === 1 && zone.y === 0 && Math.abs(zone.h - 6 / 55) < 1e-9,
  );
  const footer = zoneRect('footer', format);
  d.check(
    'zona rodapé: 4 cm na base',
    Math.abs(footer.y + footer.h - 1) < 1e-9 && Math.abs(footer.h - 4 / 55) < 1e-9,
  );
  const margin = marginPx(0.04, 1920, 3840);
  const grown = authorizedRegion(
    await rasterizeRegion({ kind: 'rect', rect: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } }, 1920, 3840),
    margin,
  );
  const box = bboxOf(grown) as Box;
  d.check(
    'margem de 4% do menor lado (77 px) em cada lado',
    margin === 77 && box.w === Math.round(0.5 * 1920) - Math.round(0.4 * 1920) + 2 * 77,
  );
}

export async function runShapeDrills(d: Drill): Promise<void> {
  await cropCases(d);
  await shapeCases(d);
}
