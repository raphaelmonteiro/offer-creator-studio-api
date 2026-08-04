import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RenderJob } from '../entities/render-job.entity';
import { AnimationAsset } from '../entities/animation-asset.entity';
import { RenderStatus } from '../domain/task-state-machine';
import { FfmpegGraphBuilder, RenderLayer, RenderSpec } from '../domain/ffmpeg-graph-builder';
import { TaskTransitionService } from '../services/task-transition.service';

const RENDER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Consumer render.export (TDD §6.1/§6.5): resolve camadas em caminhos locais,
 * constrói o comando via FfmpegGraphBuilder e executa com timeout, nice e
 * progresso via -progress pipe:1 (throttle 1s → SSE).
 */
@Injectable()
export class FfmpegRenderProcessor {
  private readonly logger = new Logger(FfmpegRenderProcessor.name);
  private readonly builder = new FfmpegGraphBuilder();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly transitions: TaskTransitionService,
  ) {}

  async process({ renderId }: { renderId: string }): Promise<void> {
    const repo = this.dataSource.getRepository(RenderJob);
    const job = await repo.findOneBy({ id: renderId });
    if (!job) return;

    const started = await this.dataSource.transaction((m) =>
      this.transitions.transitionRender(m, renderId, RenderStatus.QUEUED, RenderStatus.COMPOSITING),
    );
    if (!started) return; // cancelado ou já em processamento — no-op

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `render-${renderId.slice(0, 8)}-`));
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
        await this.runFfmpeg(args, spec.durationMs, async (pct) => {
          const overall = Math.round(((i + pct / 100) / passes.length) * 100);
          await this.dataSource.transaction((m) =>
            this.transitions.reportRenderProgress(m, renderId, Math.min(99, overall)),
          );
        });
      }
      // output atômico via rename — retomada pós-restart nunca vê arquivo parcial
      await fs.rename(`${outputPath}.part`, outputPath);

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
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Resolve assetId/url das camadas em caminhos locais absolutos. */
  private async resolveSpec(job: RenderJob): Promise<RenderSpec> {
    const raw = job.spec as unknown as RenderSpec & {
      layers: Array<RenderLayer & { assetId?: string; url?: string }>;
    };
    const uploadsDir = path.resolve(this.config.get('UPLOAD_DEST', './uploads'));
    const layers: RenderLayer[] = [];
    for (const layer of raw.layers) {
      let urlPath = layer.url ?? null;
      let hasAlpha = false;
      if (layer.assetId) {
        const asset = await this.dataSource
          .getRepository(AnimationAsset)
          .findOneByOrFail({ id: layer.assetId });
        // mascote com mezanino alpha usa alphaUrl (TDD §5.2)
        urlPath = (layer.type === 'mascot' && asset.alphaUrl) || asset.fileUrl;
        hasAlpha = asset.hasAlpha;
      }
      if (!urlPath) continue;
      const relative = urlPath.replace(/^\/uploads\//, '');
      const filePath = path.resolve(uploadsDir, relative);
      if (!filePath.startsWith(uploadsDir + path.sep)) {
        throw new Error(`Caminho fora do diretório de uploads: ${urlPath}`);
      }
      layers.push({ ...layer, filePath, hasAlpha });
    }
    return { ...raw, layers };
  }

  private runFfmpeg(
    args: string[],
    durationMs: number,
    onProgress: (pct: number) => Promise<void>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = this.config.get('FFMPEG_PATH', 'ffmpeg');
      const child = spawn(ffmpeg, ['-nostdin', '-progress', 'pipe:1', ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`ffmpeg excedeu ${RENDER_TIMEOUT_MS / 1000}s`));
      }, RENDER_TIMEOUT_MS);

      let stderr = '';
      let lastReport = 0;
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      child.stdout.on('data', (d: Buffer) => {
        const match = /out_time_ms=(\d+)/.exec(d.toString());
        if (match && Date.now() - lastReport > 1000) {
          lastReport = Date.now();
          const pct = Math.min(100, Math.round((Number(match[1]) / 1000 / durationMs) * 100));
          void onProgress(pct).catch(() => undefined);
        }
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-500)}`));
      });
    });
  }
}
