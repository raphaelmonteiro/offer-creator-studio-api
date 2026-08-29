import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, LessThan } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AnimationAsset } from '../media-assets/animation-asset.entity';
import { EXPORT_RETENTION_MS, SOFT_DELETED_RETENTION_MS, selectGarbage } from './uploads-gc.rules';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Espera pós-boot antes da primeira varredura (não competir com o start dos consumers). */
const INITIAL_DELAY_MS = 5 * 60 * 1000;

export interface GcRunSummary {
  dryRun: boolean;
  scanned: number;
  selectedAssets: number;
  deletedFiles: number;
  skippedFiles: number;
}

/**
 * GC diário de uploads/animations (TDD ADR-05, plano-comerciais §11).
 *
 * Mecanismo: `setInterval` de 24h DENTRO do worker (WORKER_ONLY=true) — a
 * opção mais simples entre as duas do plano. Uma fila pg-boss agendada exigiria
 * suporte a cron no QueuePort e uma fila extra só para isso; como o worker é um
 * único processo PM2 e apagar arquivo já apagado é no-op, o timer em processo
 * dá a mesma garantia com muito menos peças. Se o worker escalar horizontal,
 * migrar para `boss.schedule` é trivial (a seleção já é função pura).
 *
 * Segurança nesta fase: DRY-RUN por padrão — só apaga de verdade com
 * `GC_DRY_RUN=false` explícito no ambiente.
 */
@Injectable()
export class UploadsGcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadsGcService.name);
  private initialTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (process.env.WORKER_ONLY !== 'true') return; // GC roda apenas no worker
    if (this.config.get('ANIMATIONS_ENABLED') === 'false') return;
    this.initialTimer = setTimeout(() => void this.safeRun(), INITIAL_DELAY_MS);
    this.initialTimer.unref();
    this.timer = setInterval(() => void this.safeRun(), DAY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
  }

  private async safeRun(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`GC de uploads falhou: ${(err as Error).message}`);
    }
  }

  /** Uma varredura completa. Exposto para disparo manual/testes. */
  async runOnce(now = new Date()): Promise<GcRunSummary> {
    // default de segurança nesta fase: só apaga com GC_DRY_RUN=false explícito
    const dryRun = process.env.GC_DRY_RUN !== 'false';
    const softDeleteCutoff = new Date(now.getTime() - SOFT_DELETED_RETENTION_MS);
    const exportCutoff = new Date(now.getTime() - EXPORT_RETENTION_MS);

    const candidates = await this.dataSource.getRepository(AnimationAsset).find({
      withDeleted: true, // a regra principal é justamente sobre soft-deletados
      where: [
        { deletedAt: LessThan(softDeleteCutoff) },
        { kind: 'export', createdAt: LessThan(exportCutoff) },
      ],
    });
    const selections = selectGarbage(candidates, now);

    const uploadsDir = path.resolve(this.config.get('UPLOAD_DEST', './uploads'));
    let deletedFiles = 0;
    let skippedFiles = 0;
    for (const selection of selections) {
      for (const url of selection.files) {
        const absolute = path.resolve(uploadsDir, url.replace(/^\/uploads\//, ''));
        if (!absolute.startsWith(uploadsDir + path.sep)) {
          skippedFiles += 1;
          this.logger.warn(`GC ignorou caminho fora de uploads: ${url}`);
          continue;
        }
        if (!dryRun) {
          try {
            await fs.unlink(absolute);
          } catch (err) {
            skippedFiles += 1;
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              this.logger.warn(`GC não conseguiu apagar ${url}: ${(err as Error).message}`);
            }
            continue;
          }
        }
        deletedFiles += 1;
        // log estruturado do que foi (ou seria) apagado
        this.logger.log(
          JSON.stringify({
            gc: 'uploads',
            action: dryRun ? 'would_delete' : 'deleted',
            assetId: selection.assetId,
            reason: selection.reason,
            file: url,
          }),
        );
      }
    }

    const summary: GcRunSummary = {
      dryRun,
      scanned: candidates.length,
      selectedAssets: selections.length,
      deletedFiles,
      skippedFiles,
    };
    this.logger.log(`GC de uploads: ${JSON.stringify(summary)}`);
    return summary;
  }
}
