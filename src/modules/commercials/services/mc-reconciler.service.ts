import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnimationQueueService } from '../../../shared/queue/animation-queue.service';
import { MC_WATCHDOG_MIN_AGE_MS, McOrphanStep, mcWatchdogTarget } from '../domain/mc-watchdog';
import { McStepStatus } from '../domain/mc-state-machines';

/**
 * Reconciliador (watchdog) de steps órfãos — ver domain/mc-watchdog.ts para a
 * motivação e a decisão pura. Roda SÓ no worker, a cada 60s, e repõe no máximo
 * 20 jobs por ciclo (backpressure). A detecção de "órfão" é feita no SQL:
 * step em estado de trabalho sem NENHUM job vivo (created/retry/active) no
 * pg-boss cujo data->>'stepId' o referencie.
 */
@Injectable()
export class McReconcilerService implements OnModuleDestroy {
  private readonly logger = new Logger(McReconcilerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
  ) {}

  /** Chamado pelo CommercialsModule apenas no processo worker (WORKER_ONLY). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        this.logger.warn(`watchdog: ciclo falhou (${(err as Error).message}) — próximo em 60s`),
      );
    }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    const cutoff = new Date(Date.now() - MC_WATCHDOG_MIN_AGE_MS).toISOString();
    const orphans: McOrphanStep[] = await this.dataSource.query(
      `SELECT s."id", s."projectId", s."type", s."status", s."provider", s."providerJobId"
         FROM mc_steps s
        WHERE s."status" IN ($1, $2, $3)
          AND COALESCE(s."startedAt", s."createdAt") < $4
          AND NOT EXISTS (
                SELECT 1 FROM pgboss.job j
                 WHERE j.state IN ('created', 'retry', 'active')
                   AND j.data->>'stepId' = s."id"::text
              )
        ORDER BY s."createdAt"
        LIMIT 20`,
      [McStepStatus.QUEUED, McStepStatus.PROVIDER_WAIT, McStepStatus.INGESTING, cutoff],
    );
    let requeued = 0;
    for (const step of orphans) {
      const target = mcWatchdogTarget(step, Date.now());
      if (!target) continue;
      await this.queue.publish(target.queue, target.payload, target.options);
      requeued += 1;
      this.logger.warn(
        `watchdog: step órfão ${step.id} (${step.type}/${step.status}) reposto em ${target.queue}`,
      );
    }
    return requeued;
  }
}
