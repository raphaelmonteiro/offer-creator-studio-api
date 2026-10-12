import { HttpException, HttpStatus } from '@nestjs/common';
import {
  isScenesAspectRatio,
  MC_ASPECT_RATIOS,
  MC_SCENES_ASPECT_RATIOS,
  McAspectRatio,
  McProjectFormat,
} from './mc-types';

/**
 * Resolução de saída dos formatos NOVOS (change video-formatos-personagem,
 * design D12): F1 `talking_art` e F2 `offer_carousel` compõem em 1080p. O
 * formato `scenes` (F3) continua em `assemblyDimensions` (720p, mc-assembly-
 * graph) — intocado — e recusa 4:5 na admissão.
 *
 * Funções puras: sem Nest/TypeORM além da HttpException do guard de admissão
 * (mesmo precedente de `assertFormatEnabled` em mc-pipeline.config).
 */
export interface CompositionDimensions {
  width: number;
  height: number;
}

export const MC_COMPOSITION_DIMENSIONS: Record<McAspectRatio, CompositionDimensions> = {
  '9:16': { width: 1080, height: 1920 },
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

export function compositionDimensions(aspectRatio: McAspectRatio): CompositionDimensions {
  const dims = MC_COMPOSITION_DIMENSIONS[aspectRatio];
  if (!dims) {
    throw new Error(
      `Aspecto desconhecido "${String(aspectRatio)}" (aceitos: ${MC_ASPECT_RATIOS.join(', ')})`,
    );
  }
  return { ...dims };
}

/** Tolerância relativa da "igualdade" com um dos quatro aspectos (D12: 2%). */
export const MC_ASPECT_INFER_TOLERANCE = 0.02;

/** Razão largura/altura de cada aspecto (para a inferência). */
const ASPECT_RATIO_VALUE: Record<McAspectRatio, number> = {
  '9:16': 9 / 16,
  '4:5': 4 / 5,
  '1:1': 1,
  '16:9': 16 / 9,
};

/**
 * Aspecto de saída inferido de uma arte largura×altura (design D12):
 * 1. igual a um dos quatro aspectos com tolerância de 2% (relativa) → esse;
 * 2. senão, pela razão largura/altura: < 0,7 → 9:16; 0,7 a 0,9 → 4:5;
 *    0,9 a 1,1 → 1:1; > 1,1 → 16:9 (limites inclusivos no aspecto "de cima":
 *    exatamente 0,7 cai em 4:5 e exatamente 0,9/1,1 caem em 1:1).
 * Ex.: NINI 1280×928 = 1,38 → 16:9; página 20×27 = 0,74 → 4:5.
 * A arte nunca é cortada: é encaixada inteira no aspecto com preenchimento.
 */
export function inferAspectRatio(width: number, height: number): McAspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Dimensões inválidas para inferir o aspecto: ${width}×${height}`);
  }
  const ratio = width / height;
  for (const aspect of MC_ASPECT_RATIOS) {
    const target = ASPECT_RATIO_VALUE[aspect];
    if (Math.abs(ratio - target) / target <= MC_ASPECT_INFER_TOLERANCE) return aspect;
  }
  if (ratio < 0.7) return '9:16';
  if (ratio < 0.9) return '4:5';
  if (ratio <= 1.1) return '1:1';
  return '16:9';
}

/** Aspectos aceitos por formato: `scenes` só os três do executor 720p; os novos aceitam os quatro. */
export function supportedAspectRatios(format: McProjectFormat): readonly McAspectRatio[] {
  return format === 'scenes' ? MC_SCENES_ASPECT_RATIOS : MC_ASPECT_RATIOS;
}

export function isAspectSupportedForFormat(format: McProjectFormat, aspectRatio: string): boolean {
  if (format === 'scenes') return isScenesAspectRatio(aspectRatio);
  return (MC_ASPECT_RATIOS as readonly string[]).includes(aspectRatio);
}

/**
 * Regra de negócio da admissão (convenção D13: forma do DTO → 400 pelo pipe;
 * regra → 422 com código): o formato `scenes` recusa `4:5` ANTES de qualquer
 * gasto ou escrita. Chamada em `createProject` (e, quando existir, na
 * duplicação em outro aspecto).
 */
export function assertAspectSupportedForFormat(format: McProjectFormat, aspectRatio: string): void {
  if (isAspectSupportedForFormat(format, aspectRatio)) return;
  throw new HttpException(
    {
      code: 'ASPECT_NOT_SUPPORTED_FOR_FORMAT',
      message:
        `O aspecto "${aspectRatio}" não é suportado pelo formato "${format}" ` +
        `(aceitos: ${supportedAspectRatios(format).join(', ')})`,
      details: { format, aspectRatio, supported: [...supportedAspectRatios(format)] },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
