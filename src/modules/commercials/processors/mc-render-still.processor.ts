import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource, In } from 'typeorm';
import { FfmpegRunner } from '../../../shared/ffmpeg/ffmpeg-runner';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { Font } from '../../fonts/entities/font.entity';
import { compositionDimensions } from '../domain/mc-composition.config';
import {
  McPieceDocument,
  pieceCanonicalHash,
  pieceFontFamilies,
  resolvePieceFonts,
} from '../domain/mc-piece';
import { buildOfferPieceStillProps } from '../domain/mc-piece-still-props';
import { mcRenderAssetBaseUrl } from '../domain/mc-render.config';
import { McStepStatus } from '../domain/mc-state-machines';
import { computeRenderStillHash } from '../domain/mc-step-hashes';
import { McStepType } from '../domain/mc-types';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStillRendererService } from '../services/mc-still-renderer';
import { McStorageService } from '../services/mc-storage.service';

/**
 * Consumer do step de projeto `render_still` da peça de ofertas (fila
 * `mc.render`, change video-peca-configuravel, 6.1/6.2):
 *
 * 1. O descritor CONGELADO do projeto (`pieceSnapshot`) + dimensões do formato
 *    + fontes da conta citadas pelos textos viram as props da composição
 *    `OfferPieceStill` (mídias em URL absoluta).
 * 2. Hash EXATO = descritor canônico + aspecto + versão da composição +
 *    renderizador + fontes: um quadro anterior (do mesmo usuário) com o mesmo
 *    hash e arquivo presente é REAPROVEITADO sem renderizar.
 * 3. Senão, o renderizador do ambiente (Remotion, ou o mock em sharp) escreve
 *    o PNG; o arquivo é conferido (dimensões do formato) e publicado como
 *    asset `piece_still` em `/final/v{n}/still.png` — a arte de fundo do
 *    `compose_ffmpeg` desta entrega.
 *
 * Não depende das cenas: roda enquanto as falas gravam (scheduler, 6.3).
 */
@Injectable()
export class McRenderStillProcessor {
  private readonly logger = new Logger(McRenderStillProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly ffmpeg: FfmpegRunner,
    private readonly storage: McStorageService,
    private readonly renderers: McStillRendererService,
  ) {}

  async process({ stepId }: { stepId: string; projectId?: string }): Promise<void> {
    const step = await this.pipeline.claimStep(stepId, McStepType.RENDER_STILL);
    if (!step) return;
    const project = await this.dataSource
      .getRepository(McProject)
      .findOneBy({ id: step.projectId });
    if (!project) return;

    const tempDir = await this.ffmpeg.createTempDir('mc-still-');
    try {
      const document = (project.pieceSnapshot ?? null) as McPieceDocument | null;
      if (!document || !Array.isArray(document.blocks)) {
        throw new TerminalProviderError(
          'Projeto da peça de ofertas sem descritor congelado (pieceSnapshot)',
          'piece_snapshot_missing',
        );
      }
      const { width, height } = compositionDimensions(project.aspectRatio);
      const renderer = this.renderers.current();
      const compositionVersion = await renderer.compositionVersion();
      const fonts = resolvePieceFonts(document, await this.fontRows(document));
      const pieceHash = pieceCanonicalHash(document);
      const inputHash = computeRenderStillHash({
        pieceHash,
        aspectRatio: project.aspectRatio,
        compositionVersion,
        renderer: renderer.kind,
        fonts,
      });
      const snapshot: Record<string, unknown> = {
        pieceHash,
        pieceId: project.pieceId ?? null,
        aspectRatio: project.aspectRatio,
        width,
        height,
        compositionVersion,
        renderer: renderer.kind,
        fonts,
      };

      // reaproveitamento por hash (mesmo usuário, arquivo ainda no disco)
      const reused = await this.reusableStill(project.userId, inputHash, step.id);
      if (reused) {
        await this.dataSource.transaction(async (manager) => {
          await manager.update(
            McStep,
            { id: step.id },
            { inputHash, inputSnapshot: { ...snapshot, reusedFromStepId: reused.stepId } },
          );
          await this.pipeline.completeStepAndAdvance(manager, step, {
            from: McStepStatus.RUNNING,
            outputAssetId: reused.assetId,
            provider: 'cache',
            consumeOnSuccess: false,
          });
        });
        return;
      }

      // render
      const base = mcRenderAssetBaseUrl();
      const { props, sources } = buildOfferPieceStillProps({
        document,
        width,
        height,
        fonts,
        assetBaseUrl: base,
      });
      const localFiles: Record<string, string> = {};
      for (const [absolute, original] of Object.entries(sources)) {
        const local = this.storage.absoluteFromUrl(original);
        if (local) localFiles[absolute] = local;
      }
      const output = path.join(tempDir, 'still.png');
      await renderer.renderStill({ props, localFiles, outputPath: output });
      const meta = await sharp(output)
        .metadata()
        .catch(() => null);
      if (!meta?.width || !meta?.height) {
        throw new TerminalProviderError('Quadro renderizado ilegível', 'still_invalid');
      }
      if (meta.width !== width || meta.height !== height) {
        throw new TerminalProviderError(
          `Quadro em ${meta.width}×${meta.height}, esperado ${width}×${height}`,
          'still_dimensions_mismatch',
        );
      }

      // publica em /final/v{n}/still.png (mesma pasta do compose e do finalize desta entrega)
      const version = await this.nextDeliveryVersion(project.id);
      const relDir = this.storage.finalRelDir(project.userId, project.id, version);
      const target = await this.storage.prepareStreamTarget(relDir, 'still.png');
      await this.storage.copyFile(output, target.partPath);
      await fs.rename(target.partPath, target.finalPath);
      const fileSize = (await fs.stat(target.finalPath)).size;

      await this.dataSource.transaction(async (manager) => {
        const asset = await manager.getRepository(AnimationAsset).save({
          userId: project.userId,
          kind: 'piece_still' as const,
          status: 'ready' as const,
          name: `Quadro — ${project.title.slice(0, 60)} (v${version})`,
          origin: 'ai_generated' as const,
          fileUrl: target.url,
          mimeType: 'image/png',
          width,
          height,
          durationMs: null,
          fileSize: String(fileSize),
          metadata: {
            projectId: project.id,
            version,
            format: 'offer_piece',
            aspectRatio: project.aspectRatio,
            pieceId: project.pieceId ?? null,
            pieceHash,
            renderer: renderer.kind,
            compositionVersion,
            fonts,
          },
        });
        await manager.update(McStep, { id: step.id }, { inputHash, inputSnapshot: snapshot });
        await this.pipeline.completeStepAndAdvance(manager, step, {
          from: McStepStatus.RUNNING,
          outputAssetId: asset.id,
          provider: renderer.kind === 'mock' ? 'mock' : 'remotion',
          consumeOnSuccess: true, // tabela: 0 (render determinístico)
        });
      });
    } catch (err) {
      this.logger.error(`render_still ${stepId} falhou: ${(err as Error).message}`);
      await this.pipeline.failStep(step, McStepStatus.RUNNING, err, {
        fallbackCode: 'still_render_failed',
      });
    } finally {
      await this.ffmpeg.removeTempDir(tempDir);
    }
  }

  /** Arquivos das fontes da conta citadas pelos textos da peça. */
  private async fontRows(
    document: McPieceDocument,
  ): Promise<Array<Pick<Font, 'family' | 'fileUrl'>>> {
    const families = pieceFontFamilies(document);
    if (families.length === 0) return [];
    return this.dataSource.getRepository(Font).find({
      where: { family: In(families) },
      select: ['family', 'fileUrl'],
      order: { createdAt: 'ASC' },
    });
  }

  /** Quadro anterior com o MESMO hash, do mesmo usuário, com arquivo presente → reaproveitado. */
  private async reusableStill(
    userId: string,
    inputHash: string,
    excludeStepId: string,
  ): Promise<{ stepId: string; assetId: string } | null> {
    const row = await this.dataSource
      .getRepository(McStep)
      .createQueryBuilder('s')
      .innerJoin(McProject, 'p', 'p.id = s."projectId"')
      .where('p."userId" = :userId', { userId })
      .andWhere('s.type = :type', { type: McStepType.RENDER_STILL })
      .andWhere('s."inputHash" = :inputHash', { inputHash })
      .andWhere('s.status = :status', { status: McStepStatus.SUCCEEDED })
      .andWhere('s."outputAssetId" IS NOT NULL')
      .andWhere('s.id <> :excludeStepId', { excludeStepId })
      .orderBy('s."finishedAt"', 'DESC')
      .getOne();
    if (!row?.outputAssetId) return null;
    const asset = await this.dataSource
      .getRepository(AnimationAsset)
      .findOneBy({ id: row.outputAssetId });
    const file = asset?.fileUrl ? this.storage.absoluteFromUrl(asset.fileUrl) : null;
    if (!file) return null;
    const exists = await fs
      .stat(file)
      .then((st) => st.size > 0)
      .catch(() => false);
    return exists ? { stepId: row.id, assetId: row.outputAssetId } : null;
  }

  /** Versão da entrega = finalizações entregues + 1 (quadro, compose e finalize partilham a pasta). */
  private async nextDeliveryVersion(projectId: string): Promise<number> {
    const delivered = await this.dataSource.getRepository(McStep).count({
      where: { projectId, type: McStepType.FINALIZE, status: McStepStatus.SUCCEEDED },
    });
    return delivered + 1;
  }
}
