import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import {
  GEMINI_VISION_MODEL,
  GeminiImageProvider,
} from '../../../shared/providers/gemini-image.provider';
import { mcShouldRetry } from '../domain/mc-error-classes';

/**
 * Inspeção automática do clipe gerado (opção B, 24/09): o Kling Avatar às
 * vezes INVENTA letreiros, placas, etiquetas e "legendas" ilegíveis. Depois do
 * download, amostramos quadros e perguntamos ao Gemini (visão) se há texto
 * indesejado; o ingest reprova o clipe (classe `quality` → nova geração) até
 * o teto e depois aceita, com o veredito gravado no asset.
 *
 * Nunca derruba o ingest: qualquer erro aqui vira `null` (sem veredito).
 * Desligável com MC_CLIP_TEXT_CHECK=off.
 */
export interface ClipInspection {
  flagged: boolean;
  where: string | null;
  description: string;
  frames: number;
  model: string;
}

export const MC_CLIP_INSPECTION_FRAMES = 4;

export const MC_CLIP_INSPECTION_PROMPT = [
  'You are the QA reviewer of a short animated supermarket commercial. The images are frames',
  'sampled from ONE generated video clip of a cartoon mascot in a store aisle.',
  'Task: detect UNWANTED TEXT rendered inside the scene by the video generator: captions,',
  'subtitles, signs, hanging boards, banners, posters, price tags, stickers, watermarks or',
  'garbled/illegible glyphs that look like writing.',
  'NOT unwanted: the printed label of a real product package that the mascot holds or that',
  'sits on the shelves (brand name and package art are expected).',
  'Answer ONLY with compact JSON: {"unwanted_text": true|false, "where": "top|middle|bottom|null",',
  '"description": "<max 20 words>"}.',
].join(' ');

@Injectable()
export class McClipInspectorService {
  private readonly logger = new Logger(McClipInspectorService.name);

  constructor(
    private readonly ffmpeg: FfmpegRunner,
    private readonly gemini: GeminiImageProvider,
  ) {}

  enabled(): boolean {
    return process.env.MC_CLIP_TEXT_CHECK !== 'off';
  }

  /** Quadros em instantes espalhados (evita o 1º quadro, que é o keyframe). */
  static sampleTimesS(durationMs: number, frames: number = MC_CLIP_INSPECTION_FRAMES): number[] {
    const d = Math.max(0.2, durationMs / 1000);
    return Array.from({ length: frames }, (_, i) =>
      Number(((d * (i + 1)) / (frames + 1)).toFixed(2)),
    );
  }

  static parseVerdict(
    text: string,
  ): { flagged: boolean; where: string | null; description: string } | null {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as {
        unwanted_text?: unknown;
        where?: unknown;
        description?: unknown;
      };
      if (typeof parsed.unwanted_text !== 'boolean') return null;
      return {
        flagged: parsed.unwanted_text,
        where: typeof parsed.where === 'string' && parsed.where !== 'null' ? parsed.where : null,
        description: typeof parsed.description === 'string' ? parsed.description.slice(0, 200) : '',
      };
    } catch {
      return null;
    }
  }

  /**
   * Decisão do ingest a partir do veredito: 'retry' = reprova e regera (classe
   * quality), 'accept' = teto de gerações atingido, entrega com registro,
   * 'ok' = limpo ou sem veredito.
   */
  static decision(
    inspection: ClipInspection | null,
    executionsSoFar: number,
  ): 'retry' | 'accept' | 'ok' {
    if (!inspection?.flagged) return 'ok';
    return mcShouldRetry('quality', executionsSoFar) ? 'retry' : 'accept';
  }

  async inspect(
    videoPath: string,
    durationMs: number,
    tempDir: string,
  ): Promise<ClipInspection | null> {
    if (!this.enabled()) return null;
    try {
      const times = McClipInspectorService.sampleTimesS(durationMs);
      const frames: Buffer[] = [];
      for (const [i, t] of times.entries()) {
        const out = path.join(tempDir, `inspect-${i}.jpg`);
        await this.ffmpeg.run(
          [
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-ss',
            String(t),
            '-i',
            videoPath,
            '-frames:v',
            '1',
            '-q:v',
            '4',
            '-vf',
            'scale=540:-2',
            out,
          ],
          { durationMs: 1000, timeoutMs: 30_000 },
        );
        frames.push(await fs.readFile(out));
      }
      const text = await this.gemini.describeImages({
        prompt: MC_CLIP_INSPECTION_PROMPT,
        images: frames,
      });
      const verdict = McClipInspectorService.parseVerdict(text);
      if (!verdict) {
        this.logger.warn(`Inspeção do clipe: resposta não interpretável: ${text.slice(0, 120)}`);
        return null;
      }
      return { ...verdict, frames: frames.length, model: GEMINI_VISION_MODEL };
    } catch (err) {
      this.logger.warn(
        `Inspeção do clipe indisponível (${(err as Error).message}) — clipe segue sem veredito.`,
      );
      return null;
    }
  }
}
