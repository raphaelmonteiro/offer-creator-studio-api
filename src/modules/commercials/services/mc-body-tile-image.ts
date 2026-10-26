import { UnprocessableEntityException } from '@nestjs/common';
import * as sharp from 'sharp';
import { McBodyTilePlan } from '../domain/mc-body-tile';
import { chooseCutoutKey, McCutoutKeyDecision } from '../domain/mc-cutout-key';
import {
  edgeUniformity,
  keyEdgeBackground,
  MC_TILE_EDGE_TOLERANCE,
  McEdgeUniformity,
} from '../domain/mc-tile';

/**
 * Processamento de imagem do tile de corpo (sharp, custo zero): leitura raw, checagem da
 * borda, chaveamento do fundo, render do tile e decisão da chave do recorte.
 */

const EDGE_SAMPLE_SIZE = 256;
const KEY_SAMPLE_SIZE = 512;
/** Anel (px) de alfa zerado nas bordas de cima e dos lados do tile final: ruído nunca encosta. */
const EDGE_CLEAR_PX = 2;

export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
}

export async function readRaw(source: Buffer): Promise<RawImage> {
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height) {
    throw new UnprocessableEntityException({
      code: 'KIT_IDENTITY_FILE_INVALID',
      message: 'A imagem da identidade do kit não pôde ser lida.',
    });
  }
  return { data, width: info.width, height: info.height };
}

/** Borda de cima e laterais livres (o corpo pode sair por baixo): senão 422 com saída "busto". */
export async function assertBorder(raw: RawImage): Promise<McEdgeUniformity> {
  const sample = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  })
    .resize(EDGE_SAMPLE_SIZE, EDGE_SAMPLE_SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const uniformity = edgeUniformity(
    { data: sample.data, width: sample.info.width, height: sample.info.height, channels: 4 },
    { bodyMayCrossSides: true },
  );
  if (uniformity.uniform) return uniformity;
  throw new UnprocessableEntityException({
    code: 'BODY_TILE_BORDER_NOT_UNIFORM',
    message:
      'O fundo da identidade não é liso (gradiente, cenário ou a cabeça encosta na borda): ' +
      'não dá para recortar o corpo. Use o enquadramento de busto.',
    details: { fractions: uniformity.fractions, actions: ['use_bust'] },
  });
}

/** Fundo liso vira alfa (mesma inundação do tile de busto); no-op se a identidade já é transparente. */
export function keyBackground(raw: RawImage, uniformity: McEdgeUniformity): void {
  if (uniformity.transparent) return;
  keyEdgeBackground(
    { data: raw.data, width: raw.width, height: raw.height, channels: 4 },
    uniformity.background,
    MC_TILE_EDGE_TOLERANCE,
  );
}

export async function renderTile(raw: RawImage, plan: McBodyTilePlan): Promise<Buffer> {
  const { data, info } = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  })
    .extract(plan.extract)
    .extend({ ...plan.extend, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(plan.output.width, plan.output.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  clearEdges(data, info.width, info.height);
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** Nenhum pixel opaco encosta nas bordas de cima, esquerda e direita. */
function clearEdges(data: Buffer, width: number, height: number): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onEdge = y < EDGE_CLEAR_PX || x < EDGE_CLEAR_PX || x >= width - EDGE_CLEAR_PX;
      if (onEdge) data[(y * width + x) * 4 + 3] = 0;
    }
  }
}

export async function decideKey(raw: RawImage): Promise<McCutoutKeyDecision> {
  const sample = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: 4 },
  })
    .resize(KEY_SAMPLE_SIZE, KEY_SAMPLE_SIZE, { fit: 'inside' })
    .raw()
    .toBuffer();
  return chooseCutoutKey({ data: sample, channels: 4 });
}
