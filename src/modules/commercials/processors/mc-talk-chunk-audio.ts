import * as fs from 'fs/promises';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { MC_DATA_URI_MAX_BYTES } from '../domain/mc-pipeline.config';
import { buildChunkSpliceArgs, ChunkAudioFormat } from '../domain/mc-talk-chunk-ffmpeg';
import { chunkPlanFromSnapshot, ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { planChunkAudioSplice } from '../domain/mc-talk-chunks';
import { McTalkAudioPadding, talkEngineMinAudioS } from '../domain/mc-talk-engines';

/**
 * Emenda do áudio do trecho (change video-fala-continua, D5), executada via FfmpegRunner: os TTS das
 * falas, os silêncios da timeline, a cauda de junção e o enchimento ÚNICO do motor (H3) num só arquivo.
 */
export interface SplicedChunkAudio {
  buffer: Buffer;
  /** Duração MEDIDA do arquivo (ms); nunca abaixo do pedido. */
  durationMs: number | null;
  /** Registro do enchimento do motor (mesma forma de hoje, sobre o trecho); `null` = sem enchimento. */
  padding: McTalkAudioPadding | null;
}

export async function spliceChunkAudio(
  ffmpeg: FfmpegRunner,
  args: {
    model: string;
    chunk: ChunkSnapshot;
    /** Bytes dos TTS, alinhados a `chunk.speeches`. */
    tts: Buffer[];
    format: ChunkAudioFormat;
    /** Enchimento do motor (envio ao motor); a trilha das fatias vai sem. */
    withPad: boolean;
  },
): Promise<SplicedChunkAudio> {
  const plan = chunkPlanFromSnapshot(args.chunk, args.model);
  const splice = planChunkAudioSplice(plan);
  const dir = await ffmpeg.createTempDir('mc-talk-chunk-audio-');
  try {
    const inputs: string[] = [];
    for (const [i, bytes] of args.tts.entries()) {
      const file = path.join(dir, `tts-${i}.mp3`);
      await fs.writeFile(file, bytes);
      inputs.push(file);
    }
    const output = path.join(dir, `chunk.${args.format}`);
    const totalMs = args.withPad ? splice.totalMs : plan.audioMs;
    await ffmpeg.run(
      buildChunkSpliceArgs({
        inputs,
        plan: splice,
        output,
        format: args.format,
        withPad: args.withPad,
      }),
      { durationMs: totalMs, timeoutMs: 60_000 },
    );
    const buffer = await fs.readFile(output);
    if (args.format === 'mp3' && buffer.length > MC_DATA_URI_MAX_BYTES) {
      throw new TerminalProviderError(
        'Áudio do trecho excede o teto de 3,3MB do data URI',
        'audio_too_large',
      );
    }
    const probe = await ffmpeg.probe(output).catch(() => null);
    const durationMs = Math.max(totalMs, probe?.durationMs ?? 0);
    const minS = talkEngineMinAudioS(args.model);
    const padded = args.withPad && splice.padMs > 0 && minS != null;
    return {
      buffer,
      durationMs,
      padding: padded
        ? { engineModel: args.model, minS, speechMs: plan.audioMs, submittedMs: durationMs }
        : null,
    };
  } finally {
    await ffmpeg.removeTempDir(dir);
  }
}
