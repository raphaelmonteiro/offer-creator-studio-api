import { Logger } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { buildPosterArgs } from '../domain/mc-assembly-graph';
import { speechWindowsFromAlignment, SpeechWindow } from '../domain/mc-captions';
import { McStepStatus } from '../domain/mc-state-machines';
import {
  buildChunkConformSliceArgs,
  ChunkSliceSpan,
  planChunkSlices,
} from '../domain/mc-talk-chunk-ffmpeg';
import { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { conformedOutputIssue, TalkConformPlan } from '../domain/mc-talk-conform-graph';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import type { ClipInspection } from '../services/mc-clip-inspector.service';
import { spliceChunkAudio } from './mc-talk-chunk-audio';
import { planConformWithGate, TalkConformGate } from './mc-talk-conform-gate';
import type { TalkResolutionRecord } from './mc-ingest.processor';

/** Fatia já conformada, em disco (uma por fala do trecho). */
interface SliceFile extends ChunkSliceSpan {
  path: string;
  measured: { width: number | null; height: number | null; durationMs: number | null };
}

interface ConformedChunk {
  fullPath: string;
  measured: { width: number | null; height: number | null; durationMs: number | null };
  slices: SliceFile[];
  gate: TalkConformGate;
  speechWindows: SpeechWindow[];
  rawDurationMs: number;
  rawWidth: number | null;
  rawHeight: number | null;
  leaderAudioAssetId: string;
}

/** Ganchos do processor (inspeção, resolução e custo vivem lá e valem para a fala e para o trecho). */
export interface ChunkIngestHelpers {
  checkResolution(
    step: McStep,
    project: McProject,
    measured: { width: number | null; height: number | null },
  ): Promise<TalkResolutionRecord>;
  inspect(
    step: McStep,
    project: McProject,
    clip: {
      path: string;
      durationMs: number;
      tempDir: string;
      talk: boolean;
      speechWindows: SpeechWindow[];
    },
  ): Promise<ClipInspection | null>;
  billing(
    step: McStep,
    project: McProject,
    rawDurationMs: number | null,
    talk: boolean,
  ): {
    providerCostUsd: number;
    billedDurationMs: number | null;
    engineRecord: Record<string, unknown>;
  };
}

export interface ChunkIngestArgs {
  step: McStep;
  project: McProject;
  chunk: ChunkSnapshot;
  tempDir: string;
  videoPath: string;
  probe: { width: number | null; height: number | null; durationMs: number | null };
}

/**
 * Ingest do `talk` de um TRECHO (change video-fala-continua, D7/D8): conforma o clipe do motor ao áudio
 * do trecho e o fatia por fala NUM passe só, inspeciona o trecho inteiro (uma chamada), publica uma
 * fatia por cena (a líder leva custo e telemetria) e, no mesmo commit, deixa as cenas seguidoras
 * `ready` e conclui o step.
 */
export class McTalkChunkIngest {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
    private readonly pipeline: McPipelineService,
    private readonly logger: Logger,
  ) {}

  async run(args: ChunkIngestArgs, helpers: ChunkIngestHelpers): Promise<void> {
    const { step, project, chunk, tempDir } = args;
    const conformed = await this.conform(args);
    const resolution = await helpers.checkResolution(step, project, conformed.measured);
    const inspection = await helpers.inspect(step, project, {
      path: conformed.fullPath,
      durationMs: conformed.measured.durationMs ?? 0,
      tempDir,
      talk: true,
      speechWindows: conformed.speechWindows,
    });
    const scenes = await this.chunkScenes(chunk);
    const published = await this.publishSlices(project, scenes, conformed);
    const chunkAsset = await this.publishFull(project, scenes[0], conformed, tempDir);
    const billing = helpers.billing(step, project, args.probe.durationMs, true);
    await this.dataSource.transaction(async (manager) => {
      const leaderAssetId = await this.saveAssets(manager, {
        step,
        project,
        chunk,
        scenes,
        conformed,
        published,
        chunkAsset,
        resolution,
        inspection,
        billing,
      });
      await this.completeChunk(manager, {
        step,
        project,
        scenes,
        leaderAssetId,
        published,
        billing,
      });
    });
  }

  // ──────────────────────────── conformação + fatias ────────────────────────────

  private async conform(args: ChunkIngestArgs): Promise<ConformedChunk> {
    const { step, chunk, tempDir, videoPath, probe } = args;
    const audio = await this.loadSpeeches(chunk);
    if (probe.durationMs == null) {
      throw new TerminalProviderError(
        'Duração do clipe desconhecida — impossível conformar',
        'invalid_video',
      );
    }
    const snapshot = (step.inputSnapshot ?? {}) as {
      tileAssetId?: string | null;
      tileWidth?: number | null;
      tileHeight?: number | null;
      engine?: { model?: string } | null;
    };
    let { tileWidth = null, tileHeight = null } = snapshot;
    if ((tileWidth == null || tileHeight == null) && snapshot.tileAssetId) {
      const tile = await this.dataSource
        .getRepository(AnimationAsset)
        .findOneBy({ id: snapshot.tileAssetId });
      tileWidth = tile?.width ?? null;
      tileHeight = tile?.height ?? null;
    }
    const gate = planConformWithGate(
      {
        videoMs: probe.durationMs,
        audioMs: chunk.audioMs,
        videoWidth: probe.width,
        videoHeight: probe.height,
        tileWidth,
        tileHeight,
      },
      step,
      this.logger,
    );
    // trilha das fatias: os TTS originais nos instantes do trecho, sem o enchimento do motor
    const spliced = await spliceChunkAudio(this.ffmpeg, {
      model: snapshot.engine?.model ?? '',
      chunk,
      tts: audio.map((a) => a.buffer),
      format: 'wav',
      withPad: false,
    });
    const audioPath = path.join(tempDir, 'chunk-voice.wav');
    await fs.writeFile(audioPath, spliced.buffer);
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
    const issue = conformedOutputIssue(
      { hasVideo: true, hasAudio: true, durationMs: measured.durationMs },
      chunk.audioMs,
    );
    if (issue) {
      throw new TerminalProviderError(`Clipe conformado inválido: ${issue}`, 'talk_conform_failed');
    }
    return {
      fullPath,
      measured,
      slices,
      gate,
      speechWindows: this.windows(chunk, audio),
      rawDurationMs: probe.durationMs,
      rawWidth: probe.width,
      rawHeight: probe.height,
      leaderAudioAssetId: chunk.speeches[0].audioAssetId,
    };
  }

  private async probeOrFail(file: string) {
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
  private async loadSpeeches(chunk: ChunkSnapshot) {
    const out: Array<{ buffer: Buffer; alignment: unknown }> = [];
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

  // ──────────────────────────────── publicação ────────────────────────────────

  private async chunkScenes(chunk: ChunkSnapshot): Promise<McScene[]> {
    const rows = await this.dataSource
      .getRepository(McScene)
      .find({ where: { id: In(chunk.sceneRowIds) } });
    const ordered = chunk.sceneRowIds.map((id) => rows.find((r) => r.id === id));
    if (ordered.some((r) => !r)) {
      throw new TerminalProviderError('Cena do trecho não encontrada', 'missing_input_asset');
    }
    return ordered as McScene[];
  }

  private async publishSlices(project: McProject, scenes: McScene[], conformed: ConformedChunk) {
    const stamp = Date.now();
    const out: Array<{
      assetId: string;
      fileUrl: string;
      posterUrl: string;
      thumbUrl: string;
      size: number;
    }> = [];
    for (const [i, slice] of conformed.slices.entries()) {
      const scene = scenes[i];
      const relDir = this.storage.sceneRelDir(
        project.userId,
        project.id,
        scene.idx,
        scene.generation,
      );
      out.push({
        assetId: randomUUID(),
        ...(await this.publishFile(relDir, `synced-${stamp}-c${i}`, slice.path)),
      });
    }
    return out;
  }

  /** Trecho inteiro (inspeção e referência); só existe com mais de uma fatia. */
  private async publishFull(
    project: McProject,
    leader: McScene,
    conformed: ConformedChunk,
    _tempDir: string,
  ) {
    if (conformed.slices.length < 2) return null;
    const relDir = this.storage.sceneRelDir(
      project.userId,
      project.id,
      leader.idx,
      leader.generation,
    );
    return {
      assetId: randomUUID(),
      ...(await this.publishFile(relDir, `chunk-${Date.now()}`, conformed.fullPath)),
    };
  }

  private async publishFile(relDir: string, base: string, file: string) {
    const posterPath = `${file}.poster.jpg`;
    await this.ffmpeg.run(buildPosterArgs(file, posterPath), {
      durationMs: 1000,
      timeoutMs: 60_000,
    });
    const poster = await fs.readFile(posterPath);
    const thumb = await sharp(poster).resize({ width: 320 }).jpeg({ quality: 80 }).toBuffer();
    const target = await this.storage.prepareStreamTarget(relDir, `${base}.mp4`);
    await this.storage.copyFile(file, target.partPath);
    await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
    return {
      fileUrl: target.url,
      posterUrl: await this.storage.saveFile(relDir, `${base}-poster.jpg`, poster),
      thumbUrl: await this.storage.saveFile(relDir, `${base}-thumb.jpg`, thumb),
      size: (await fs.stat(target.finalPath)).size,
    };
  }

  private async saveAssets(
    manager: EntityManager,
    input: {
      step: McStep;
      project: McProject;
      chunk: ChunkSnapshot;
      scenes: McScene[];
      conformed: ConformedChunk;
      published: Awaited<ReturnType<McTalkChunkIngest['publishSlices']>>;
      chunkAsset: Awaited<ReturnType<McTalkChunkIngest['publishFull']>>;
      resolution: TalkResolutionRecord;
      inspection: ClipInspection | null;
      billing: ReturnType<ChunkIngestHelpers['billing']>;
    },
  ): Promise<string> {
    const { step, project, chunk, scenes, conformed, published, chunkAsset } = input;
    const repo = manager.getRepository(AnimationAsset);
    const slicesMeta = conformed.slices.map((slice, i) => ({
      sceneRowId: scenes[i].id,
      assetId: published[i].assetId,
      speechMs: slice.speechMs,
    }));
    for (const [i, slice] of conformed.slices.entries()) {
      const leader = i === 0;
      await repo.save({
        id: published[i].assetId,
        userId: project.userId,
        kind: 'scene_synced' as const,
        status: 'ready' as const,
        name: `Cena ${scenes[i].idx + 1} — ${project.title.slice(0, 40)}`,
        origin: 'ai_generated' as const,
        fileUrl: published[i].fileUrl,
        posterUrl: published[i].posterUrl,
        thumbUrl: published[i].thumbUrl,
        mimeType: 'video/mp4',
        width: slice.measured.width,
        height: slice.measured.height,
        durationMs: slice.measured.durationMs,
        fileSize: String(published[i].size),
        metadata: {
          projectId: project.id,
          sceneId: scenes[i].id,
          generation: scenes[i].generation,
          provider: step.provider,
          providerJobId: step.providerJobId,
          sceneType: 'talk_tile',
          chunkStepId: step.id,
          chunkIndex: chunk.index,
          chunkAssetId: chunkAsset?.assetId ?? null,
          speechMs: slice.speechMs,
          joinedToNext: slice.joinedToNext,
          ...(leader ? this.leaderMetadata(input, slicesMeta) : {}),
        },
      });
    }
    if (chunkAsset) {
      await repo.save({
        id: chunkAsset.assetId,
        userId: project.userId,
        kind: 'talk_chunk_clip' as const,
        status: 'ready' as const,
        name: `Trecho ${chunk.index + 1} — ${project.title.slice(0, 40)}`,
        origin: 'ai_generated' as const,
        fileUrl: chunkAsset.fileUrl,
        posterUrl: chunkAsset.posterUrl,
        thumbUrl: chunkAsset.thumbUrl,
        mimeType: 'video/mp4',
        width: conformed.measured.width,
        height: conformed.measured.height,
        durationMs: conformed.measured.durationMs,
        fileSize: String(chunkAsset.size),
        metadata: {
          projectId: project.id,
          chunkStepId: step.id,
          chunkIndex: chunk.index,
          slices: slicesMeta,
        },
      });
    }
    return published[0].assetId;
  }

  /** Telemetria do trecho no asset da fatia LÍDER (custo, motor, conformação, inspeção); as demais não levam custo. */
  private leaderMetadata(
    input: {
      conformed: ConformedChunk;
      chunk: ChunkSnapshot;
      resolution: TalkResolutionRecord;
      inspection: ClipInspection | null;
      billing: ReturnType<ChunkIngestHelpers['billing']>;
      step: McStep;
    },
    slices: Array<{ sceneRowId: string; assetId: string; speechMs: number }>,
  ): Record<string, unknown> {
    const { conformed, billing, resolution, inspection, step, chunk } = input;
    const { plan, verdict, accepted } = conformed.gate;
    return {
      providerCostUsd: Number(billing.providerCostUsd.toFixed(4)),
      ...billing.engineRecord,
      resolution,
      ...(resolution.requiredLongSidePx != null
        ? { premiumResolutionOk: resolution.ok === true }
        : {}),
      chunkSlices: slices,
      conform: conformMetadata(plan, verdict, accepted, conformed, chunk),
      ...(inspection
        ? {
            inspected: inspection.available,
            inspection: { ...inspection, accepted: inspection.flagged, executions: step.attempts },
          }
        : {}),
    };
  }

  /** Conclui: seguidoras `ready` com a fatia delas, depois o step (a líder fica `ready` e o scheduler avança). */
  private async completeChunk(
    manager: EntityManager,
    input: {
      step: McStep;
      project: McProject;
      scenes: McScene[];
      leaderAssetId: string;
      published: Array<{ assetId: string }>;
      billing: ReturnType<ChunkIngestHelpers['billing']>;
    },
  ): Promise<void> {
    const { step, project, scenes, published } = input;
    for (const [i, scene] of scenes.entries()) {
      if (i === 0) continue;
      await this.pipeline.markChunkSceneReady(manager, project.userId, scene, published[i].assetId);
    }
    await this.pipeline.completeStepAndAdvance(manager, step, {
      from: McStepStatus.INGESTING,
      outputAssetId: input.leaderAssetId,
      providerCostUsd: input.billing.providerCostUsd,
      consumeOnSuccess: false, // consumo já aconteceu no submit (§6.7)
    });
  }
}

function conformMetadata(
  plan: TalkConformPlan,
  verdict: TalkConformGate['verdict'],
  accepted: TalkConformGate['accepted'],
  conformed: ConformedChunk,
  chunk: ChunkSnapshot,
): Record<string, unknown> {
  return {
    durationAction: verdict,
    executedAction: plan.durationAction,
    deltaMs: plan.deltaMs,
    padS: plan.padS,
    crop: plan.crop,
    rawDurationMs: conformed.rawDurationMs,
    rawWidth: conformed.rawWidth,
    rawHeight: conformed.rawHeight,
    audioMs: chunk.audioMs,
    audioAssetId: conformed.leaderAudioAssetId,
    audioPolicy: 'replace_clip_audio',
    ...(accepted
      ? { accepted: true, acceptedReason: accepted.reason, executions: accepted.executions }
      : {}),
  };
}
