import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { FalQueueClient } from '../../../shared/providers/fal-queue.client';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { buildPosterArgs } from '../domain/mc-assembly-graph';
import {
  isAllowedFalVideoUrl,
  MC_INGEST_MAX_BYTES,
  mcUsdPerSecond,
} from '../domain/mc-pipeline.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McScene } from '../entities/mc-scene.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/**
 * Consumer da fila mc.ingest (conc. 2, gate ResourceGuard — plano §6.4):
 * baixa o vídeo pronto do provider e o transforma no asset final da cena.
 *
 * Anti-SSRF endurecido (plano §6.8 — o ingest do animations não tem nada
 * disso): a URL do vídeo sai do RESULTADO do provider e mesmo assim só é
 * baixada se for https com hostname na allowlist da fal (fal.media,
 * *.fal.media, *.fal.run — hostname PARSEADO, nunca substring); cap de 200MB
 * com contagem durante o stream; escrita em .part + rename atômico; ffprobe
 * valida que é vídeo de verdade ANTES de virar asset; poster (frame 0) +
 * thumb 320px (sharp).
 *
 * Provider mock: lê o clipe de mock-jobs/ direto do disco (nada de rede) —
 * o caminho real de validação/probe/poster roda igual.
 */
@Injectable()
export class McIngestProcessor {
  private readonly logger = new Logger(McIngestProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly fal: FalQueueClient,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
  ) {}

  async process({ stepId, responseUrl }: { stepId: string; responseUrl?: string }): Promise<void> {
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    // Só steps que o poll moveu para ingesting; re-entrega dupla é resolvida
    // no CAS final (o segundo download perde e vira no-op).
    if (!step || step.status !== McStepStatus.INGESTING) return;

    const scene = step.sceneId
      ? await this.dataSource.getRepository(McScene).findOneBy({ id: step.sceneId })
      : null;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!scene || !project) return;
    const tempDir = await this.ffmpeg.createTempDir('mc-ingest-');
    try {
      const videoPath = path.join(tempDir, 'video.mp4');
      if (step.provider === 'mock') {
        await this.copyMockClip(step.providerJobId as string, videoPath);
      } else {
        const videoUrl = await this.fal.resultVideoUrl(
          responseUrl ?? `https://queue.fal.run/${step.provider}/requests/${step.providerJobId}`,
        );
        this.assertAllowedUrl(videoUrl);
        await this.downloadStream(videoUrl, videoPath);
      }

      // ffprobe ANTES de aceitar (plano §6.8): sem stream de vídeo = lixo.
      const probe = await this.ffmpeg.probe(videoPath).catch((err: Error) => {
        throw new TerminalProviderError(
          `ffprobe rejeitou o download: ${err.message}`,
          'invalid_video',
        );
      });
      if (!probe.hasVideo) {
        throw new TerminalProviderError('Download sem stream de vídeo', 'invalid_video');
      }

      // poster (frame 0) + thumb 320px
      const posterPath = path.join(tempDir, 'poster.jpg');
      await this.ffmpeg.run(buildPosterArgs(videoPath, posterPath), {
        durationMs: 1000,
        timeoutMs: 60_000,
      });
      const posterBuffer = await fs.readFile(posterPath);
      const thumbBuffer = await sharp(posterBuffer)
        .resize({ width: 320 })
        .jpeg({ quality: 80 })
        .toBuffer();

      const relDir = this.storage.sceneRelDir(
        project.userId,
        project.id,
        scene.idx,
        scene.generation,
      );
      const stamp = Date.now();
      const target = await this.storage.prepareStreamTarget(relDir, `synced-${stamp}.mp4`);
      await fs.copyFile(videoPath, target.partPath);
      await this.ffmpeg.finalizeOutput(target.partPath, target.finalPath);
      const videoFileUrl = target.url;
      const posterUrl = await this.storage.saveFile(
        relDir,
        `synced-${stamp}-poster.jpg`,
        posterBuffer,
      );
      const thumbUrl = await this.storage.saveFile(
        relDir,
        `synced-${stamp}-thumb.jpg`,
        thumbBuffer,
      );
      const fileSize = (await fs.stat(target.finalPath)).size;

      // Custo real por SEGUNDO do motor que gerou o clipe: Avatar no lipsync,
      // Kling v3 de ação no video (plano §6.7 — telemetria de margem por step).
      const providerCostUsd =
        step.provider === 'mock' || probe.durationMs == null
          ? 0
          : (probe.durationMs / 1000) * mcUsdPerSecond(step.type);

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          // lipsync = cena falada sincronizada; video = clipe cru de cena muda
          kind:
            step.type === McStepType.LIPSYNC ? ('scene_synced' as const) : ('scene_clip' as const),
          status: 'ready' as const,
          name: `Cena ${scene.idx + 1} — ${project.title.slice(0, 40)}`,
          origin: 'ai_generated' as const,
          fileUrl: videoFileUrl,
          posterUrl,
          thumbUrl,
          mimeType: 'video/mp4',
          width: probe.width,
          height: probe.height,
          durationMs: probe.durationMs,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            sceneId: scene.id,
            generation: scene.generation,
            provider: step.provider,
            providerJobId: step.providerJobId,
          },
        });
        // Conclui + cena ready (este é o step final da cena falada/muda) +
        // avanço do scheduler (assembly quando todas prontas) NA TRANSAÇÃO.
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.INGESTING,
          outputAssetId: asset.id,
          providerCostUsd,
          consumeOnSuccess: false, // consumo já aconteceu no submit (§6.7)
        });
      });
    } catch (err) {
      this.logger.error(`Ingest ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.INGESTING, err, {
        fallbackCode: 'ingest_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }
  }

  // ─────────────────────────────── interno ───────────────────────────────

  /** Validação exportável no domain (mc-pipeline.config) — aqui só o erro tipado. */
  private assertAllowedUrl(url: string): void {
    if (!isAllowedFalVideoUrl(url)) {
      throw new TerminalProviderError(
        `URL de vídeo fora da allowlist do provider: ${url.slice(0, 120)}`,
        'ingest_blocked_host',
      );
    }
  }

  /** Download por stream com cap de 200MB (aborta no meio — nunca bufferiza tudo em RAM). */
  private async downloadStream(url: string, destPath: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new TransientProviderError(`Falha de rede no download: ${(err as Error).message}`);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new TransientProviderError(`Download HTTP ${response.status}`);
    }
    if (!response.ok || !response.body) {
      throw new TerminalProviderError(
        `Download rejeitado: HTTP ${response.status}`,
        'download_failed',
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MC_INGEST_MAX_BYTES) {
      throw new TerminalProviderError(
        `Vídeo declara ${declared} bytes (> cap de 200MB)`,
        'video_too_large',
      );
    }
    const partPath = `${destPath}.part`;
    const handle = await fs.open(partPath, 'w');
    let received = 0;
    try {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.length;
          if (received > MC_INGEST_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            throw new TerminalProviderError('Vídeo excedeu o cap de 200MB', 'video_too_large');
          }
          await handle.write(value);
        }
      }
    } finally {
      await handle.close();
    }
    await this.ffmpeg.finalizeOutput(partPath, destPath); // rename atômico
  }

  private async copyMockClip(jobId: string, destPath: string): Promise<void> {
    const mockPath = this.storage.mockJobAbsPath(jobId);
    try {
      await fs.copyFile(mockPath, destPath);
    } catch {
      throw new TerminalProviderError('Clipe mock ausente no disco', 'mock_job_missing');
    }
  }
}
