import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RenderJob } from '../entities/render-job.entity';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { MediaAssetsService } from '../../../shared/media-assets/media-assets.service';
import { RenderStatus } from '../../../shared/state/task-state-machine';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { FfmpegGraphBuilder, RenderSpec } from '../domain/ffmpeg-graph-builder';
import { AnyRenderLayer, isSyncedClip } from '../domain/synced-clip';

/**
 * Consumer render.export (TDD §6.1/§6.5): resolve camadas em caminhos locais,
 * constrói o comando via FfmpegGraphBuilder (específico deste módulo — overlay
 * de camadas) e executa via FfmpegRunner compartilhado (spawn com timeout,
 * progresso via -progress pipe:1 com throttle 1s → SSE, tempdir por job,
 * output atômico e anti-path-traversal — plano-comerciais §11).
 */
@Injectable()
export class FfmpegRenderProcessor {
  private readonly logger = new Logger(FfmpegRenderProcessor.name);
  private readonly builder = new FfmpegGraphBuilder();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly transitions: TaskTransitionService,
    private readonly mediaAssets: MediaAssetsService,
    private readonly runner: FfmpegRunner,
  ) {}

  async process({ renderId }: { renderId: string }): Promise<void> {
    const repo = this.dataSource.getRepository(RenderJob);
    const job = await repo.findOneBy({ id: renderId });
    if (!job) return;

    const started = await this.dataSource.transaction((m) =>
      this.transitions.transitionRender(m, renderId, RenderStatus.QUEUED, RenderStatus.COMPOSITING),
    );
    if (!started) return; // cancelado ou já em processamento — no-op

    const tmpDir = await this.runner.createTempDir(`render-${renderId.slice(0, 8)}-`);
    try {
      const spec = await this.resolveSpec(job);
      const uploadsDir = this.config.get('UPLOAD_DEST', './uploads');
      const outDir = path.join(uploadsDir, 'animations', job.userId, 'exports');
      await fs.mkdir(outDir, { recursive: true });
      const fileName = `${renderId}.${spec.format}`;
      const outputPath = path.join(outDir, fileName);
      const { passes } = this.builder.build(spec, `${outputPath}.part`, tmpDir);

      await this.dataSource.transaction((m) =>
        this.transitions.transitionRender(
          m,
          renderId,
          RenderStatus.COMPOSITING,
          RenderStatus.ENCODING,
        ),
      );
      for (const [i, args] of passes.entries()) {
        await this.runner.run(args, {
          durationMs: spec.durationMs,
          onProgress: async (pct) => {
            const overall = Math.round(((i + pct / 100) / passes.length) * 100);
            await this.dataSource.transaction((m) =>
              this.transitions.reportRenderProgress(m, renderId, Math.min(99, overall)),
            );
          },
        });
      }
      // output atômico via rename — retomada pós-restart nunca vê arquivo parcial
      await this.runner.finalizeOutput(`${outputPath}.part`, outputPath);

      const stat = await fs.stat(outputPath);
      const asset = await this.dataSource.getRepository(AnimationAsset).save({
        userId: job.userId,
        kind: 'export' as const,
        status: 'ready' as const,
        name: `Exportação ${new Date().toISOString().slice(0, 10)}`,
        origin: 'export' as const,
        fileUrl: `/uploads/animations/${job.userId}/exports/${fileName}`,
        mimeType:
          spec.format === 'mp4' ? 'video/mp4' : spec.format === 'webm' ? 'video/webm' : 'image/gif',
        width: spec.width,
        height: spec.height,
        durationMs: spec.durationMs,
        fileSize: String(stat.size),
        metadata: { renderId },
      });
      await this.dataSource.transaction((m) =>
        this.transitions.transitionRender(
          m,
          renderId,
          RenderStatus.ENCODING,
          RenderStatus.SUCCEEDED,
          {
            outputAssetId: asset.id,
            progressPct: 100,
            finishedAt: new Date(),
          },
        ),
      );
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? 'Erro desconhecido';
      this.logger.error(`Render ${renderId} falhou: ${message}`);
      await this.dataSource.transaction(async (m) => {
        (await this.transitions.transitionRender(
          m,
          renderId,
          RenderStatus.ENCODING,
          RenderStatus.FAILED,
          { errorMessage: message, finishedAt: new Date() },
        )) ||
          (await this.transitions.transitionRender(
            m,
            renderId,
            RenderStatus.COMPOSITING,
            RenderStatus.FAILED,
            { errorMessage: message, finishedAt: new Date() },
          ));
      });
    } finally {
      await this.runner.removeTempDir(tmpDir);
    }
  }

  /**
   * Resolve assetId/url das camadas em caminhos locais absolutos.
   * `synced_clip` (spike §3.5) tem DOIS arquivos (vídeo e áudio) e é resolvido
   * lado a lado — a expansão em duas camadas fica com o FfmpegGraphBuilder,
   * que é quem garante o `startMs` idêntico.
   */
  private async resolveSpec(job: RenderJob): Promise<RenderSpec> {
    // No spec persistido as camadas ainda referenciam assetId/url; `filePath`
    // só passa a existir depois desta resolução.
    const raw = job.spec as unknown as RenderSpec & {
      layers: Array<AnyRenderLayer & { assetId?: string; url?: string }>;
    };
    const uploadsDir = path.resolve(this.config.get('UPLOAD_DEST', './uploads'));
    const layers: AnyRenderLayer[] = [];
    for (const layer of raw.layers) {
      if (isSyncedClip(layer)) {
        const video = await this.resolveSource(uploadsDir, layer.video, 'mascot');
        const audio = await this.resolveSource(uploadsDir, layer.audio, 'audio');
        if (!video || !audio) continue;
        layers.push({
          ...layer,
          video: { ...layer.video, filePath: video.filePath, hasAlpha: video.hasAlpha },
          audio: { ...layer.audio, filePath: audio.filePath },
        });
        continue;
      }
      const resolved = await this.resolveSource(uploadsDir, layer, layer.type);
      if (!resolved) continue;
      layers.push({ ...layer, filePath: resolved.filePath, hasAlpha: resolved.hasAlpha });
    }
    return { ...raw, layers };
  }

  private async resolveSource(
    uploadsDir: string,
    source: { assetId?: string; url?: string },
    type: string,
  ): Promise<{ filePath: string; hasAlpha: boolean } | null> {
    let urlPath = source.url ?? null;
    let hasAlpha = false;
    if (source.assetId) {
      const asset = await this.mediaAssets.findByIdOrFail(source.assetId);
      // mascote com mezanino alpha usa alphaUrl (TDD §5.2)
      urlPath = (type === 'mascot' && asset.alphaUrl) || asset.fileUrl;
      hasAlpha = asset.hasAlpha;
    }
    if (!urlPath) return null;
    return { filePath: this.runner.resolveUploadPath(uploadsDir, urlPath), hasAlpha };
  }
}
