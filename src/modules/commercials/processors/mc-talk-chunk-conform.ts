import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { speechWindowsFromAlignment, SpeechWindow } from '../domain/mc-captions';
import {
  buildChunkConformSliceArgs,
  ChunkSliceSpan,
  planChunkSlices,
} from '../domain/mc-talk-chunk-ffmpeg';
import { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import {
  conformedOutputIssue,
  MC_TALK_CONFORM_TOLERANCE_MS,
} from '../domain/mc-talk-conform-graph';
import { McStorageService } from '../services/mc-storage.service';
import { spliceChunkAudio } from './mc-talk-chunk-audio';
import { planConformWithGate, TalkConformGate } from './mc-talk-conform-gate';
import type {
  ChunkIngestArgs,
  ConformedChunk,
  MeasuredClip,
  SliceFile,
} from './mc-talk-chunk-ingest.types';

interface ConformSnapshot {
  tileAssetId?: string | null;
  tileWidth?: number | null;
  tileHeight?: number | null;
  engine?: { model?: string } | null;
}

interface SpeechAudio {
  buffer: Buffer;
  alignment: unknown;
}

/**
 * Conformação do `talk` de um trecho (change video-fala-continua, D7/D8): ajusta o clipe do motor ao
 * áudio do trecho e o fatia por fala NUM passe só de ffmpeg.
 */
export class McTalkChunkConformer {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
    private readonly logger: Logger,
  ) {}

  async conform(args: ChunkIngestArgs): Promise<ConformedChunk> {
    const { step, chunk, tempDir, videoPath, probe } = args;
    const audio = await this.loadSpeeches(chunk);
    if (probe.durationMs == null) {
      throw new TerminalProviderError(
        'Duração do clipe desconhecida — impossível conformar',
        'invalid_video',
      );
    }
    const snapshot = (step.inputSnapshot ?? {}) as ConformSnapshot;
    const gate = await this.planGate(args, snapshot, probe.durationMs);
    const audioPath = await this.writeChunkVoice(args, snapshot, audio);
    const spans = planChunkSlices(chunk);
    const sliceOutputs = spans.map((_s, i) => path.join(tempDir, `slice-${i}.mp4`));
    const fullOutput = spans.length > 1 ? path.join(tempDir, 'chunk-full.mp4') : null;
    this.logger.log(
      `Ingest ${step.id}: trecho ${chunk.index + 1}/${chunk.count} — conformando e fatiando em ${spans.length} (${gate.plan.durationAction}, Δ=${gate.plan.deltaMs}ms)`,
    );
    await this.ffmpeg.run(
      buildChunkConformSliceArgs({
        videoPath,
        audioPath,
        plan: gate.plan,
        slices: spans,
        audioMs: chunk.audioMs,
        sliceOutputs,
        fullOutput,
      }),
      { durationMs: chunk.audioMs, timeoutMs: 240_000 },
    );
    const out = await this.probeOutputs(spans, sliceOutputs, fullOutput);
    const issue = this.durationIssue(chunk, fullOutput ? out.measured : null, out.slices);
    if (issue) {
      throw new TerminalProviderError(`Clipe conformado inválido: ${issue}`, 'talk_conform_failed');
    }
    return {
      ...out,
      gate,
      speechWindows: this.windows(chunk, audio),
      rawDurationMs: probe.durationMs,
      rawWidth: probe.width,
      rawHeight: probe.height,
      leaderAudioAssetId: chunk.speeches[0].audioAssetId,
    };
  }

  /** Plano de conformação com o gate de proporção (usa as dimensões do tile, relidas do asset se faltarem). */
  private async planGate(
    args: ChunkIngestArgs,
    snapshot: ConformSnapshot,
    videoMs: number,
  ): Promise<TalkConformGate> {
    const { tileWidth, tileHeight } = await this.tileSize(snapshot);
    return planConformWithGate(
      {
        videoMs,
        audioMs: args.chunk.audioMs,
        videoWidth: args.probe.width,
        videoHeight: args.probe.height,
        tileWidth,
        tileHeight,
      },
      args.step,
      this.logger,
    );
  }

  private async tileSize(snapshot: ConformSnapshot) {
    const { tileWidth = null, tileHeight = null } = snapshot;
    if ((tileWidth != null && tileHeight != null) || !snapshot.tileAssetId) {
      return { tileWidth, tileHeight };
    }
    const tile = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: snapshot.tileAssetId });
    return { tileWidth: tile?.width ?? null, tileHeight: tile?.height ?? null };
  }

  /** Trilha das fatias: os TTS originais nos instantes do trecho, sem o enchimento do motor. */
  private async writeChunkVoice(
    args: ChunkIngestArgs,
    snapshot: ConformSnapshot,
    audio: SpeechAudio[],
  ): Promise<string> {
    const spliced = await spliceChunkAudio(this.ffmpeg, {
      model: snapshot.engine?.model ?? '',
      chunk: args.chunk,
      tts: audio.map((a) => a.buffer),
      format: 'wav',
      withPad: false,
    });
    const audioPath = path.join(args.tempDir, 'chunk-voice.wav');
    await fs.writeFile(audioPath, spliced.buffer);
    return audioPath;
  }

  /** Mede cada fatia e o trecho inteiro (quando existe); uma fatia só é o próprio trecho. */
  private async probeOutputs(
    spans: ChunkSliceSpan[],
    sliceOutputs: string[],
    fullOutput: string | null,
  ) {
    const slices: SliceFile[] = [];
    for (const [i, span] of spans.entries()) {
      slices.push({
        ...span,
        path: sliceOutputs[i],
        measured: await this.probeOrFail(sliceOutputs[i]),
      });
    }
    const fullPath = fullOutput ?? sliceOutputs[0];
    const measured = fullOutput ? await this.probeOrFail(fullOutput) : slices[0].measured;
    return { fullPath, measured, slices };
  }

  /**
   * Duração do conformado: o trecho inteiro (`-t audioMs`) bate com o áudio; sem ele (uma fatia só), a fatia
   * não pode ser MAIS CURTA que o áudio — ela leva alguns quadros de folga depois do fim (D8), então mais
   * longa é o esperado.
   */
  private durationIssue(
    chunk: ChunkSnapshot,
    full: { durationMs: number | null } | null,
    slices: SliceFile[],
  ): string | null {
    if (full) {
      return conformedOutputIssue(
        { hasVideo: true, hasAudio: true, durationMs: full.durationMs },
        chunk.audioMs,
      );
    }
    const ms = slices[0].measured.durationMs;
    return ms != null && ms < chunk.audioMs - MC_TALK_CONFORM_TOLERANCE_MS
      ? 'conformed_duration_mismatch'
      : null;
  }

  private async probeOrFail(file: string): Promise<MeasuredClip> {
    const probe = await this.ffmpeg.probe(file).catch((err: Error) => {
      throw new TerminalProviderError(
        `ffprobe rejeitou o clipe conformado: ${err.message}`,
        'talk_conform_failed',
      );
    });
    if (!probe.hasVideo || !probe.hasAudio) {
      throw new TerminalProviderError(
        'Clipe conformado sem vídeo ou sem áudio',
        'talk_conform_failed',
      );
    }
    return { width: probe.width, height: probe.height, durationMs: probe.durationMs };
  }

  /** TTS de cada fala do trecho (bytes + alinhamento), na ordem. */
  private async loadSpeeches(chunk: ChunkSnapshot): Promise<SpeechAudio[]> {
    const out: SpeechAudio[] = [];
    for (const speech of chunk.speeches) {
      const asset = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: speech.audioAssetId });
      const buffer = asset?.fileUrl ? await this.storage.readUploadsFile(asset.fileUrl) : null;
      if (!asset || !buffer) {
        throw new TerminalProviderError('Áudio da fala ausente no disco', 'missing_input_asset');
      }
      out.push({
        buffer,
        alignment: (asset.metadata as { alignment?: unknown } | null)?.alignment,
      });
    }
    return out;
  }

  /** Janelas de fala do trecho (segundos desde o início do clipe): as de cada fala deslocadas ao instante dela. */
  private windows(chunk: ChunkSnapshot, audio: Array<{ alignment: unknown }>): SpeechWindow[] {
    return chunk.speeches.flatMap((speech, i) =>
      speechWindowsFromAlignment(
        audio[i].alignment as Parameters<typeof speechWindowsFromAlignment>[0],
      ).map((w) => ({
        startS: w.startS + speech.startMs / 1000,
        endS: w.endS + speech.startMs / 1000,
      })),
    );
  }
}
