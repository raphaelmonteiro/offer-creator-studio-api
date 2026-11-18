import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { FLYER_PRO_ENRICH_CONFIG, FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import {
  enrichError,
  finalFields,
  isActiveStatus,
  reconcileAction,
  ReconcileAction,
} from '../domain/flyer-pro-enrich-rules';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import { lockJob, updateJob } from '../processors/flyer-pro-enrich.statements';
import { publishJobBatch } from './flyer-pro-job.queue';
import { inSavepoint } from './flyer-pro-savepoint';
import { findLockedDocument } from './flyer-pro-save.statements';

/** A varredura roda no boot do worker e a cada minuto. */
export const JOB_RECONCILE_INTERVAL_MS = 60 * 1000;

/**
 * O reconciliador do job (`a3-job-enriquecimento.html#s6-4`), só no worker: retoma o job depois de reinício, dá por morto o
 * lote sem batimento, republica o lote perdido e fecha `canceled` o job com parada pedida sem lote em execução ou de
 * encarte excluído. Para cada job ativo trava o encarte e depois a linha do job (A-23) e relê o job antes de decidir; a
 * ficha (`batchSeq`) garante que republicar à vontade nunca faz o mesmo lote rodar duas vezes.
 */
@Injectable()
export class FlyerProJobReconcilerService implements OnModuleDestroy {
  private readonly logger = new Logger(FlyerProJobReconcilerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
    @Inject(FLYER_PRO_ENRICH_CONFIG) private readonly config: FlyerProEnrichConfig,
  ) {}

  /** No boot do worker e a cada minuto. */
  start(): void {
    void this.safeReconcile();
    this.timer = setInterval(() => void this.safeReconcile(), JOB_RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async safeReconcile(): Promise<void> {
    try {
      const acted = await this.reconcile();
      if (acted > 0) this.logger.warn(`${acted} job(s) de enriquecimento tratado(s) na varredura`);
    } catch (error) {
      this.logger.error(`Reconciliação do job de enriquecimento falhou: ${String(error)}`);
    }
  }

  /** Examina cada job ativo; devolve quantos a varredura mudou ou republicou. */
  async reconcile(now: Date = new Date()): Promise<number> {
    const active: Array<{ id: string; documentId: string }> = await this.dataSource.query(
      `SELECT "id", "documentId" FROM "flyer_pro_jobs" WHERE "status" IN ('queued', 'running')`,
    );
    let acted = 0;
    for (const job of active) {
      if (await this.examine(job, now)) acted += 1;
    }
    return acted;
  }

  /** Um job: encarte e depois a linha do job travados e relidos; só age se ele continua ativo. */
  private examine(job: { id: string; documentId: string }, now: Date): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const document = await findLockedDocument(manager, job.documentId, { withDeleted: true });
      const current = document ? await lockJob(manager, job.id) : null;
      if (!current || !isActiveStatus(current.status)) return false;
      const action = reconcileAction(
        {
          heartbeatAt: current.heartbeatAt ? new Date(current.heartbeatAt) : null,
          updatedAt: new Date(current.updatedAt),
          cancelRequestedAt: current.cancelRequestedAt ? new Date(current.cancelRequestedAt) : null,
          batchAttempts: current.batchAttempts ?? 0,
          documentDeleted: document.deletedAt != null,
        },
        now,
        this.config,
      );
      if (action === 'none') return false;
      await this.apply(manager, current, action);
      return true;
    });
  }

  private async apply(
    manager: EntityManager,
    job: FlyerProJob,
    action: Exclude<ReconcileAction, 'none'>,
  ): Promise<void> {
    if (action === 'cancel') {
      await updateJob(manager, job.id, {
        ...finalFields('canceled', job.phase),
        clearHeartbeat: true,
        finish: true,
      });
    } else if (action === 'fail_stalled') {
      await updateJob(manager, job.id, {
        ...finalFields('failed', job.phase),
        error: enrichError('JOB_STALLED', job.phase),
        batchAttempts: (job.batchAttempts ?? 0) + 1,
        clearHeartbeat: true,
        finish: true,
      });
    } else {
      await this.republish(manager, job, action === 'republish_dead');
    }
  }

  /**
   * Republica `{ jobId, seq: batchSeq }`. O lote morto conta uma tentativa e zera o batimento; o lote perdido só atualiza
   * `updatedAt`. A atualização e a publicação andam juntas num savepoint: se a fila falhar, nada muda e a próxima
   * varredura tenta de novo.
   */
  private async republish(manager: EntityManager, job: FlyerProJob, dead: boolean): Promise<void> {
    const done = await inSavepoint(manager, 'flyer_pro_reconcile', async () => {
      await updateJob(
        manager,
        job.id,
        dead ? { batchAttempts: (job.batchAttempts ?? 0) + 1, clearHeartbeat: true } : {},
      );
      await publishJobBatch(
        this.queue,
        manager,
        { jobId: job.id, seq: job.batchSeq },
        { expireInSeconds: this.config.batchExpireSeconds },
      );
    });
    if (!done.ok) {
      this.logger.error(`Lote do job ${job.id} não republicado: ${String(done.error)}`);
    }
  }
}
