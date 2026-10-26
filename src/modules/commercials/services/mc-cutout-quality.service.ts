import { Injectable } from '@nestjs/common';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { buildCutoutKeyChain } from '../domain/mc-cutout-graph';
import { McCutoutKeyColor } from '../domain/mc-cutout-key';
import {
  cutoutSampleFrameIndexes,
  evaluateCutoutClip,
  McCutoutClipMetrics,
  McCutoutFrame,
  measureCutoutFrame,
} from '../domain/mc-cutout-quality';
import { McCutoutReason } from '../domain/mc-cutout-issue';

/** Maior lado (px) dos quadros medidos: custo de CPU previsível; o anel de borda escala junto. */
const MEASURE_MAX_SIDE = 480;
const SAMPLE_FPS = 30;
const EXTRACT_TIMEOUT_MS = 120_000;

export interface McCutoutClipInput {
  sceneId: string;
  idx: number;
  path: string;
  durationMs: number;
}

export interface McCutoutSceneVerdict {
  sceneId: string;
  idx: number;
  passed: boolean;
  reasons: McCutoutReason[];
  metrics: McCutoutClipMetrics;
}

/** Grafo do ffmpeg: quadros escolhidos, original e alfa/cor depois da cadeia de recorte (D5). */
function buildCutoutSampleGraph(indexes: number[], keyColor: McCutoutKeyColor): string {
  const fit = `scale=${MEASURE_MAX_SIDE}:${MEASURE_MAX_SIDE}:force_original_aspect_ratio=decrease`;
  return [
    `[0:v]fps=${SAMPLE_FPS},select='${indexes.map((n) => `eq(n\\,${n})`).join('+')}',` +
      `setpts=N/${SAMPLE_FPS}/TB,split=2[orig][src]`,
    buildCutoutKeyChain('src', keyColor, 'q', 'keyed'),
    `[keyed]split=2[kalpha][kcolor]`,
    `[kalpha]alphaextract,${fit}[alpha]`,
    `[kcolor]format=rgb24,${fit}[despilled]`,
    `[orig]${fit}[origs]`,
  ].join(';');
}

/** Argumentos do ffmpeg que gravam `<prefix>-o|a|d-NN.png` (original, alfa, despilled). */
export function buildCutoutSampleArgs(
  clipPath: string,
  indexes: number[],
  keyColor: McCutoutKeyColor,
  prefix: string,
): string[] {
  const outputs: Array<[string, string]> = [
    ['[origs]', `${prefix}-o-%02d.png`],
    ['[alpha]', `${prefix}-a-%02d.png`],
    ['[despilled]', `${prefix}-d-%02d.png`],
  ];
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    clipPath,
    '-filter_complex',
    buildCutoutSampleGraph(indexes, keyColor),
    ...outputs.flatMap(([label, file]) => ['-map', label, '-start_number', '0', file]),
  ];
}

/**
 * Verificação local (sem API) do recorte de cada clipe, ANTES da composição (D7): extrai 8 quadros
 * do clipe e o alfa gerado pela mesma cadeia do compose (D5) num único ffmpeg e mede com sharp.
 */
@Injectable()
export class McCutoutQualityService {
  constructor(private readonly ffmpeg: FfmpegRunner) {}

  async verifyClips(input: {
    clips: McCutoutClipInput[];
    keyColor: McCutoutKeyColor;
    tempDir: string;
  }): Promise<{ passed: boolean; scenes: McCutoutSceneVerdict[] }> {
    const scenes: McCutoutSceneVerdict[] = [];
    for (const clip of input.clips) {
      scenes.push(await this.verifyClip(clip, input.keyColor, input.tempDir));
    }
    return { passed: scenes.every((s) => s.passed), scenes };
  }

  private async verifyClip(
    clip: McCutoutClipInput,
    keyColor: McCutoutKeyColor,
    tempDir: string,
  ): Promise<McCutoutSceneVerdict> {
    const indexes = cutoutSampleFrameIndexes(clip.durationMs / 1000, SAMPLE_FPS);
    const prefix = path.join(tempDir, `q${clip.idx}`);
    await this.ffmpeg.run(buildCutoutSampleArgs(clip.path, indexes, keyColor, prefix), {
      durationMs: clip.durationMs,
      timeoutMs: EXTRACT_TIMEOUT_MS,
    });
    const metrics = [];
    for (let i = 0; i < indexes.length; i++) {
      const n = String(i).padStart(2, '0');
      const frame = await this.readFrame(
        `${prefix}-o-${n}.png`,
        `${prefix}-a-${n}.png`,
        `${prefix}-d-${n}.png`,
      );
      metrics.push(measureCutoutFrame(frame, keyColor));
    }
    const verdict = evaluateCutoutClip(metrics);
    return { sceneId: clip.sceneId, idx: clip.idx, ...verdict };
  }

  private async readFrame(
    origFile: string,
    alphaFile: string,
    despilledFile: string,
  ): Promise<McCutoutFrame> {
    const orig = await sharp(origFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = await sharp(alphaFile).greyscale().raw().toBuffer({ resolveWithObject: true });
    const despilled = await sharp(despilledFile).removeAlpha().raw().toBuffer();
    return {
      rgb: new Uint8Array(orig.data),
      despilled: new Uint8Array(despilled),
      alpha: new Uint8Array(alpha.data),
      width: orig.info.width,
      height: orig.info.height,
    };
  }
}
