import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import {
  ElevenLabsMusicProvider,
  MUSIC_UNAVAILABLE_CODE,
} from '../../../shared/providers/elevenlabs-music.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { CommercialsService } from '../commercials.service';
import {
  buildMockMusicArgs,
  buildPosterArgs,
  ENDCARD_DURATION_S,
} from '../domain/mc-assembly-graph';
import {
  buildCaptionCues,
  ElevenLabsAlignment,
  speechWindowsFromAlignment,
  TextCue,
} from '../domain/mc-captions';
import {
  buildFinalizeGraph,
  FinalizeGraphInput,
  FinalizeMeasurePass,
  LoudnessMeasurement,
  loudnessWithinTarget,
  MC_FINALIZE_GRAPH_VERSION,
  MC_FINALIZE_LOUDNESS,
  parseEbur128Metadata,
  resolveLoudnormPlan,
  SpeechWindowInput,
} from '../domain/mc-finalize-graph';
import { McRenderedTimeline, resolveQuality } from '../domain/mc-quality';
import { McProjectStatus, McSceneStatus, McStepStatus } from '../domain/mc-state-machines';
import { WindowPx } from '../domain/mc-talking-art-window';
import { McStepType, resolveProjectOptions } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';
import { MC_MUSIC_PROMPT } from './mc-assembly.processor';

/** Timeline gravada pelo compose no asset composto (fonte da `quality.timeline` entregue). */
interface ComposedTimeline {
  totalS: number;
  scenes: Array<{
    sceneId: string;
    idx: number;
    finalAssetId: string;
    startS: number;
    endS: number;
  }>;
}

/** Trilha: mesma chave de cache da montagem F3 (prompt + duração em degrau de 5 s) — o bucket é compartilhado. */
const MUSIC_EXTRA_S = 5;
const MUSIC_BUCKET_S = 5;

/** WhatsApp acima de 16 MB: refaz o render com o bitrate reduzido (até 2 vezes). */
const WHATSAPP_RETRY_FACTORS = [0.8, 0.65];

/**
 * Consumer do step de projeto `finalize` (fila mc.ffmpeg, gate ResourceGuard —
 * change video-formatos-personagem, D6/D8/D13): parte do vídeo COMPOSTO
 * (`compose_ffmpeg` da mesma cadeia) e produz a ENTREGA do projeto.
 *
 * Resolve as entradas (legendas por linha e janelas de fala dos timestamps do
 * TTS de cada cena, trilha com cache, janela do personagem gravada pelo
 * compose) e executa o plano de `buildFinalizeGraph` (domain/mc-finalize-
 * graph): passe 1 mede a mistura (e re-mede com limitador quando o pico
 * previsto passa do teto), passe 2 renderiza com legendas + ducking +
 * loudnorm linear medido + perfil do canal (WhatsApp refeito com bitrate menor
 * se passar de 16 MB), passe 3 mede a entrega. Medições, perfil, ducking e
 * legendas ficam no asset `commercial_final`; depois poster/thumb,
 * `finalAssetId`, `quality.timeline` e e-mail não bloqueante.
 */
@Injectable()
export class McFinalizeProcessor {
  private readonly logger = new Logger(McFinalizeProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
    private readonly music: ElevenLabsMusicProvider,
    private readonly commercials: CommercialsService,
  ) {}

  private provider(): string {
    return process.env.MC_PIPELINE_PROVIDER || 'mock';
  }

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.FINALIZE);
    if (!step) return;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!project) return;

    const tempDir = await this.ffmpeg.createTempDir('mc-finalize-');
    let delivered = false;
    try {
      const composed = await this.composedAssetFor(step);
      const sourcePath = composed.fileUrl ? this.storage.absoluteFromUrl(composed.fileUrl) : null;
      if (!sourcePath) {
        throw new TerminalProviderError('Vídeo composto fora do bucket', 'composed_missing');
      }
      const sourceProbe = await this.ffmpeg.probe(sourcePath);
      if (!sourceProbe.hasVideo || !sourceProbe.hasAudio) {
        throw new TerminalProviderError(
          'Vídeo composto sem vídeo ou sem áudio',
          'composed_invalid',
        );
      }
      const meta = (composed.metadata ?? {}) as {
        timeline?: ComposedTimeline;
        endcard?: boolean;
        version?: number;
        windowPx?: WindowPx | null;
      };
      const timeline: ComposedTimeline = meta.timeline ?? { totalS: 0, scenes: [] };
      const options = resolveProjectOptions(project.options);
      const durationMs =
        sourceProbe.durationMs ?? composed.durationMs ?? Math.round(timeline.totalS * 1000);

      // entradas: timestamps do TTS por cena → legendas + janelas de fala; trilha
      const speech = await this.speechInputs(project.id, timeline, options.captionsEnabled);
      const musicPath = options.musicEnabled
        ? await this.resolveSoundtrack(project, durationMs / 1000, tempDir)
        : null;

      const input: FinalizeGraphInput = {
        sourcePath,
        output: path.join(tempDir, 'final.mp4'),
        channel: project.channel ?? null,
        width: sourceProbe.width ?? composed.width ?? 1080,
        height: sourceProbe.height ?? composed.height ?? 1920,
        musicPath,
        speechWindows: speech.windows,
        captionCues: speech.cues,
        windowPx: meta.windowPx ?? null,
        loudness: { ...MC_FINALIZE_LOUDNESS },
        durationMs,
      };
      const plan = buildFinalizeGraph(input);

      // passe 1: medição (+ re-medição com limitador quando preciso)
      await this.reportProgress(step, project, 2);
      const resolved = await resolveLoudnormPlan(
        plan.measure,
        (pass) => this.measure(pass, durationMs),
        input.loudness,
      );
      await this.reportProgress(step, project, 10);

      // passe 2: render (WhatsApp refeito com bitrate menor se passar do teto)
      let render = plan.render(resolved.loudnorm);
      let fileSize = 0;
      for (let attempt = 0; ; attempt += 1) {
        await this.ffmpeg.run(render.args, {
          durationMs,
          timeoutMs: 300_000,
          onProgress: (pct) => this.reportProgress(step, project, 10 + pct * 0.75),
        });
        fileSize = (await fs.stat(plan.output)).size;
        const maxBytes = render.profile.maxBytes;
        if (maxBytes == null || fileSize <= maxBytes) break;
        const factor = WHATSAPP_RETRY_FACTORS[attempt];
        if (factor == null) {
          throw new TerminalProviderError(
            `Entrega de ${fileSize} bytes acima do teto de ${maxBytes} do canal`,
            'channel_size_exceeded',
          );
        }
        this.logger.warn(
          `finalize ${stepId}: ${fileSize} B > ${maxBytes} B — refazendo com bitrate × ${factor}`,
        );
        render = plan.render(resolved.loudnorm, { bitrateFactor: factor });
      }
      const probeFinal = await this.ffmpeg.probe(plan.output);
      if (!probeFinal.hasVideo || !probeFinal.hasAudio) {
        throw new TerminalProviderError('Entrega sem vídeo ou sem áudio', 'final_invalid');
      }

      // passe 3: medição da entrega (registrada; fora do alvo = alerta, não falha)
      const deliveredLoudness = await this.measure(plan.verify, durationMs);
      const withinTarget = deliveredLoudness
        ? loudnessWithinTarget(deliveredLoudness, input.loudness)
        : false;
      if (!withinTarget) {
        this.logger.warn(
          `finalize ${stepId}: loudness da entrega fora do alvo ${JSON.stringify(deliveredLoudness)}`,
        );
      }
      await this.reportProgress(step, project, 88);

      // poster + thumb do final
      const posterPath = path.join(tempDir, 'poster.jpg');
      await this.ffmpeg.run(buildPosterArgs(plan.output, posterPath), {
        durationMs: 1000,
        timeoutMs: 60_000,
      });
      const posterBuffer = await fs.readFile(posterPath);
      const thumbBuffer = await sharp(posterBuffer)
        .resize({ width: 320 })
        .jpeg({ quality: 80 })
        .toBuffer();

      // publica em /final/v{n}/final.mp4 (n = entregas + 1; mesma pasta do composto)
      const version = await this.nextDeliveryVersion(project.id);
      const relDir = this.storage.finalRelDir(project.userId, project.id, version);
      const target = await this.storage.prepareStreamTarget(relDir, 'final.mp4');
      await this.storage.copyFile(plan.output, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const posterUrl = await this.storage.saveFile(relDir, 'poster.jpg', posterBuffer);
      const thumbUrl = await this.storage.saveFile(relDir, 'thumb.jpg', thumbBuffer);
      await this.reportProgress(step, project, 95);

      const loudness = {
        target: { ...input.loudness, LRA: resolved.loudnorm.lra },
        pass1: resolved.pass1,
        measurements: resolved.measurements,
        mode: resolved.loudnorm.mode,
        gainDb: resolved.loudnorm.gainDb,
        limiterDb: resolved.loudnorm.limiterDb,
        ceilingTp: resolved.loudnorm.ceilingTp,
        output: deliveredLoudness,
        withinTarget,
      };
      const snapshot: Record<string, unknown> = {
        ...input,
        sourcePath: composed.fileUrl,
        musicPath: musicPath ? 'soundtrack' : null,
        output: target.url,
        composedAssetId: composed.id,
        graphVersion: MC_FINALIZE_GRAPH_VERSION,
        profile: render.profile,
        loudness,
      };
      const lastEnd = timeline.scenes.length ? timeline.scenes[timeline.scenes.length - 1].endS : 0;
      const renderedTimeline: McRenderedTimeline = {
        revision: project.revision,
        version,
        totalS: meta.endcard ? Number((lastEnd + ENDCARD_DURATION_S).toFixed(3)) : lastEnd,
        scenes: timeline.scenes.map((s) => ({
          sceneId: s.sceneId,
          idx: s.idx,
          startS: s.startS,
          endS: s.endS,
          finalAssetId: s.finalAssetId,
          captionsMissing: speech.captionsMissingSceneIds.includes(s.sceneId),
        })),
        endcard: meta.endcard
          ? { startS: lastEnd, endS: Number((lastEnd + ENDCARD_DURATION_S).toFixed(3)) }
          : null,
        captionsRequested: options.captionsEnabled,
        captionsMissingSceneIds: speech.captionsMissingSceneIds,
        seals: [],
        renderedAt: new Date().toISOString(),
      };

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'commercial_final' as const,
          status: 'ready' as const,
          name: `Comercial — ${project.title.slice(0, 60)} (v${version})`,
          origin: 'ai_generated' as const,
          fileUrl: target.url,
          posterUrl,
          thumbUrl,
          mimeType: 'video/mp4',
          width: probeFinal.width,
          height: probeFinal.height,
          durationMs: probeFinal.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            version,
            format: project.format,
            channel: project.channel ?? null,
            aspectRatio: project.aspectRatio,
            composedAssetId: composed.id,
            graphVersion: MC_FINALIZE_GRAPH_VERSION,
            profile: render.profile,
            loudness,
            music: !!musicPath,
            musicSkipped: options.musicEnabled && !musicPath,
            ducking: musicPath ? plan.ducking : [],
            captions: plan.captions.count,
            captionBand: plan.captions.layout?.band ?? null,
            captionsMissingSceneIds: speech.captionsMissingSceneIds,
            sceneCount: timeline.scenes.length,
            endcard: !!meta.endcard,
          },
        });
        await manager.update(McStep, { id: step.id }, { inputSnapshot: snapshot });
        const completed = await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: 'ffmpeg',
          consumeOnSuccess: true, // tabela: 0
        });
        if (completed) {
          const quality = resolveQuality(project.quality);
          delivered = await this.pipeline.succeedProject(manager, project.id, asset.id, {
            quality: { ...quality, timeline: renderedTimeline },
          });
        }
      });
    } catch (err) {
      this.logger.error(`finalize ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'finalize_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }

    // E-mail FORA da transação e sempre não bloqueante (plano §7.2).
    if (delivered) {
      await this.pipeline.sendCompletionEmail(project.id, McProjectStatus.SUCCEEDED);
    }
  }

  /** Executa um passe de medição e lê o arquivo de metadados do ebur128. */
  private async measure(
    pass: FinalizeMeasurePass,
    durationMs: number,
  ): Promise<LoudnessMeasurement | null> {
    await this.ffmpeg.run(pass.args, { durationMs, timeoutMs: 120_000 });
    const text = await fs.readFile(pass.metadataPath, 'utf8').catch(() => '');
    return parseEbur128Metadata(text);
  }

  /**
   * Legendas e janelas de fala a partir do alinhamento por caractere gravado
   * no asset de áudio (TTS) de cada cena, deslocados para o instante da cena
   * na timeline do composto. Cena sem alinhamento: a fala inteira vira a
   * janela do ducking e, com legendas pedidas, a cena entra em
   * `captionsMissingSceneIds` (visível — nunca omitida em silêncio).
   */
  private async speechInputs(
    projectId: string,
    timeline: ComposedTimeline,
    captionsEnabled: boolean,
  ): Promise<{ cues: TextCue[]; windows: SpeechWindowInput[]; captionsMissingSceneIds: string[] }> {
    const scenes = (
      await this.dataSource.getRepository(McScene).find({ where: { projectId } })
    ).filter((s) => s.status !== McSceneStatus.CANCELED);
    const audioIds = scenes
      .map((s) => s.audioAssetId)
      .filter((id): id is string => typeof id === 'string');
    const audios = audioIds.length
      ? await this.dataSource.getRepository(AnimationAsset).find({ where: { id: In(audioIds) } })
      : [];
    const cues: TextCue[] = [];
    const windows: SpeechWindowInput[] = [];
    const captionsMissingSceneIds: string[] = [];
    for (const entry of timeline.scenes) {
      const scene = scenes.find((s) => (s.scriptSceneId ?? s.id) === entry.sceneId);
      const audio = scene?.audioAssetId ? audios.find((a) => a.id === scene.audioAssetId) : null;
      const alignment = (audio?.metadata?.alignment ?? null) as ElevenLabsAlignment | null;
      const clipS = Math.max(0, entry.endS - entry.startS);
      const local = speechWindowsFromAlignment(alignment);
      if (local.length > 0) {
        for (const w of local) {
          const startS = entry.startS + Math.max(0, w.startS);
          const endS = entry.startS + Math.min(clipS, w.endS);
          if (endS > startS) windows.push({ sceneId: entry.sceneId, startS, endS });
        }
      } else {
        windows.push({ sceneId: entry.sceneId, startS: entry.startS, endS: entry.endS });
      }
      if (!captionsEnabled) continue;
      const sceneCues = buildCaptionCues(alignment, {
        offsetS: entry.startS,
        clipDurationS: clipS,
      });
      if (sceneCues.length === 0) captionsMissingSceneIds.push(entry.sceneId);
      cues.push(...sceneCues);
    }
    return { cues, windows, captionsMissingSceneIds };
  }

  /**
   * Trilha do projeto com CACHE POR HASH (prompt fixo + duração em degrau de
   * 5 s), a mesma chave da montagem F3 — o bucket é compartilhado.
   * `music_unavailable` (conta sem Eleven Music) degrada: evento
   * `music_skipped` e entrega sem trilha.
   */
  private async resolveSoundtrack(
    project: McProject,
    videoDurationS: number,
    tempDir: string,
  ): Promise<string | null> {
    const lengthS = Math.ceil((videoDurationS + MUSIC_EXTRA_S) / MUSIC_BUCKET_S) * MUSIC_BUCKET_S;
    const provider = this.provider();
    const hash = createHash('sha256')
      .update(`${provider}|${MC_MUSIC_PROMPT}|${lengthS}`)
      .digest('hex')
      .slice(0, 32);
    const relDir = this.storage.musicCacheRelDir();
    const cachedPath = path.join(this.storage.uploadsDir(), relDir, `${hash}.mp3`);
    const cached = await fs
      .stat(cachedPath)
      .then(() => true)
      .catch(() => false);
    if (cached) return cachedPath;
    try {
      if (provider === 'mock') {
        const tmp = path.join(tempDir, 'music.mp3');
        await this.ffmpeg.run(buildMockMusicArgs(tmp, lengthS), {
          durationMs: lengthS * 1000,
          timeoutMs: 60_000,
        });
        await this.storage.saveFile(relDir, `${hash}.mp3`, await fs.readFile(tmp));
        return cachedPath;
      }
      const audio = await this.music.compose({ prompt: MC_MUSIC_PROMPT, lengthMs: lengthS * 1000 });
      await this.storage.saveFile(relDir, `${hash}.mp3`, audio);
      return cachedPath;
    } catch (err) {
      const code = err instanceof TerminalProviderError ? err.code : null;
      if (code !== MUSIC_UNAVAILABLE_CODE) throw err;
      this.logger.warn(
        `Trilha indisponível no projeto ${project.id} (${(err as Error).message}) — entrega sem música.`,
      );
      await this.dataSource
        .transaction((manager: EntityManager) =>
          this.commercials.appendEvent(manager, {
            userId: project.userId,
            refKind: 'project',
            refId: project.id,
            kind: 'music_skipped',
            detail: { reason: code, lengthS },
          }),
        )
        .catch(() => undefined);
      return null;
    }
  }

  /**
   * Vídeo composto da MESMA cadeia (revisão + attempt do finalize): o
   * `compose_ffmpeg` concluído mais recente com asset. Sem ele não há o que
   * finalizar (erro terminal, nunca uma entrega de outra revisão).
   */
  private async composedAssetFor(step: McStep): Promise<AnimationAsset> {
    const composeSteps = await this.dataSource.getRepository(McStep).find({
      where: {
        projectId: step.projectId,
        type: McStepType.COMPOSE_FFMPEG,
        status: McStepStatus.SUCCEEDED,
      },
      order: { finishedAt: 'DESC' },
    });
    const sameChain = composeSteps.find(
      (s) =>
        s.outputAssetId &&
        (s.projectRevision ?? null) === (step.projectRevision ?? null) &&
        (s.attempt ?? 1) === (step.attempt ?? 1),
    );
    const compose = sameChain ?? composeSteps.find((s) => !!s.outputAssetId) ?? null;
    if (!compose?.outputAssetId) {
      throw new TerminalProviderError(
        'Nenhuma composição concluída para finalizar',
        'composed_missing',
      );
    }
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: compose.outputAssetId });
    if (!asset?.fileUrl) {
      throw new TerminalProviderError('Asset do vídeo composto sem arquivo', 'composed_missing');
    }
    return asset;
  }

  /** Versão da entrega = finalizações já entregues + 1 (mesma regra do compose). */
  private async nextDeliveryVersion(projectId: string): Promise<number> {
    const delivered = await this.dataSource.getRepository(McStep).count({
      where: { projectId, type: McStepType.FINALIZE, status: McStepStatus.SUCCEEDED },
    });
    return delivered + 1;
  }

  private async reportProgress(step: McStep, project: McProject, pct: number): Promise<void> {
    const bounded = Math.max(0, Math.min(100, Math.round(pct)));
    await this.dataSource
      .transaction((manager) =>
        this.pipeline.notifyStep(manager, project.userId, step, McStepStatus.RUNNING, {
          progressPct: bounded,
        }),
      )
      .catch(() => undefined);
  }
}
