import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { FLYER_PRO_ENRICH_CONFIG, FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import {
  addCounts,
  addTiming,
  effectiveOnlyMissing,
  enrichError,
  failureDecision,
  markSkipped,
  needsAnotherRound,
  nextPhase,
  PhaseCounts,
  retryDelaySeconds,
  runnablePhases,
  withModel,
} from '../domain/flyer-pro-enrich-rules';
import type {
  EnrichCursor,
  EnrichErrorCode,
  EnrichPhase,
  EnrichStep,
} from '../domain/flyer-pro-job.types';
import type { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import { countEligible } from '../services/flyer-pro-job.scope';
import { inSavepoint } from '../services/flyer-pro-savepoint';
import { findLockedDocument, readStamp } from '../services/flyer-pro-save.statements';
import type { JobColumns } from './flyer-pro-enrich.statements';
import { lockJob, updateJob } from './flyer-pro-enrich.statements';
import type { ItemWrite, UnitPlan } from './flyer-pro-enrich.types';
import { planWrites, WriteContext } from './flyer-pro-enrich.writes';

/** O resultado de uma gravação: feita, ou descartada porque a ficha não bate (lote zumbi) ou o job sumiu. */
export type CommitOutcome = 'committed' | 'discarded';

/** A falha do provedor classificada: o código do job e se ela é terminal (sem repetição). */
export interface BatchFailure {
  code: Extract<EnrichErrorCode, 'AI_PROVIDER_ERROR' | 'AI_TIMEOUT'>;
  terminal: boolean;
}

/** O que a transação travou: o encarte, a linha do job relida e se há motivo para parar (excluído ou parada pedida). */
interface Locked {
  manager: EntityManager;
  document: FlyerProDocument;
  current: FlyerProJob;
  stopping: boolean;
}

const FRESH_CURSOR: EnrichCursor = { round: 1, pass: 0, position: null, id: null };

/**
 * As gravações do processador, cada uma numa transação curta: travam o encarte e depois a linha do job (A-23), conferem a
 * ficha (`status = running` e `batchSeq` igual ao do lote) e só então gravam; ficha que não bate descarta o resultado
 * sem tocar em nenhum item. O próximo lote é publicado na mesma transação, num savepoint.
 */
@Injectable()
export class FlyerProEnrichCommitter {
  private readonly logger = new Logger(FlyerProEnrichCommitter.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
    @Inject(FLYER_PRO_ENRICH_CONFIG) private readonly config: FlyerProEnrichConfig,
  ) {}

  /** Grava o lote (ou o fechamento ou pulo da fase) e decide o que vem depois: outro lote, outra fase, outra rodada ou o fim. */
  commitUnit(job: FlyerProJob, plan: UnitPlan): Promise<CommitOutcome> {
    return this.locked(job, async (locked) => {
      const { manager, current } = locked;
      const cursor = current.cursor ?? FRESH_CURSOR;
      const items = plan.work?.items ?? [];
      const ctx = await this.writeContext(locked, cursor.round);
      const counts = plan.work ? await applyWrites(manager, planWrites(plan.work, ctx)) : null;
      let result = counts
        ? addCounts(current.result, plan.phase, { visited: items.length, ...counts })
        : current.result;
      if (plan.skipped) result = markSkipped(result, plan.phase);
      result = addTiming(result, plan.phase, { items: items.length, durationMs: plan.totalMs });
      const last = items[items.length - 1];
      const progress: JobColumns = {
        processed: current.processed + (plan.skipped ? plan.skippedItems : items.length),
        result,
        models: plan.model ? withModel(current.models, plan.phase, plan.model) : current.models,
        batchAttempts: 0,
        clearHeartbeat: true,
      };
      const closes = plan.skipped || items.length < plan.batchSize;
      const moved = last ? { ...cursor, position: last.position, id: last.id } : cursor;
      if (locked.stopping) {
        return this.stopped(locked, { ...progress, cursor: moved, phase: plan.phase });
      }
      const next = closes
        ? await this.afterPhase(manager, current, plan.phase, result)
        : {
            phase: plan.phase as EnrichPhase | null,
            cursor: moved,
            total: current.total,
            done: false,
          };
      if (next.done) {
        await updateJob(manager, current.id, {
          ...progress,
          total: Math.max(next.total, progress.processed as number),
          ...doneColumns(next.cursor),
        });
        return 'committed';
      }
      await updateJob(manager, current.id, {
        ...progress,
        phase: next.phase,
        cursor: next.cursor,
        // Item que chegou durante a rodada e entrou nela antes de a conferência o contar: `total` nunca fica abaixo de `processed`.
        total: Math.max(next.total, progress.processed as number),
      });
      await this.publishNext(locked, 0);
      return 'committed';
    });
  }

  /**
   * Falha do provedor: o lote não grava nada nos itens. Terminal ou na última tentativa, o job termina `failed`; senão
   * `batchAttempts` sobe e o mesmo lote é republicado com a espera de 15 s e depois de 60 s.
   */
  commitFailure(
    job: FlyerProJob,
    phase: EnrichStep,
    failure: BatchFailure,
  ): Promise<CommitOutcome> {
    return this.locked(job, async (locked) => {
      if (locked.stopping) return this.stopped(locked, { clearHeartbeat: true, phase });
      const { manager, current } = locked;
      const attempts = (current.batchAttempts ?? 0) + 1;
      const decision = failureDecision({
        attempts,
        maxAttempts: this.config.maxAttempts,
        terminal: failure.terminal,
      });
      if (decision === 'fail') {
        await updateJob(manager, current.id, failedColumns(failure.code, phase, attempts));
        return 'committed';
      }
      await updateJob(manager, current.id, { batchAttempts: attempts, clearHeartbeat: true });
      await this.publishNext(locked, retryDelaySeconds(attempts) ?? 0);
      return 'committed';
    });
  }

  /** Parada pedida (ou encarte excluído) vista ao assumir o lote: fecha `canceled` sem chamar o provedor. */
  cancelClaimed(job: FlyerProJob): Promise<CommitOutcome> {
    return this.locked(job, (locked) => this.stopped(locked, { clearHeartbeat: true }));
  }

  /** Erro que não é do provedor, depois de assumir a ficha: o job termina `failed` com `INTERNAL`. */
  failUnexpected(job: FlyerProJob, phase: EnrichPhase | null): Promise<CommitOutcome> {
    return this.locked(job, async ({ manager, current }) => {
      await updateJob(manager, current.id, failedColumns('INTERNAL', phase, 0));
      return 'committed';
    });
  }

  /** Transação curta: encarte (mesmo excluído), depois a linha do job, e a ficha conferida antes de qualquer escrita. */
  private locked(
    job: FlyerProJob,
    work: (locked: Locked) => Promise<CommitOutcome>,
  ): Promise<CommitOutcome> {
    return this.dataSource.transaction(async (manager) => {
      const document = await findLockedDocument(manager, job.documentId, { withDeleted: true });
      const current = document ? await lockJob(manager, job.id) : null;
      if (!current || current.status !== 'running' || current.batchSeq !== job.batchSeq) {
        return 'discarded';
      }
      const stopping = document.deletedAt != null || current.cancelRequestedAt != null;
      return work({ manager, document, current, stopping });
    });
  }

  private async writeContext(locked: Locked, round: number): Promise<WriteContext> {
    const { manager, current } = locked;
    return {
      stamp: await readStamp(manager),
      jobId: current.id,
      documentId: current.documentId,
      autoApply: current.autoApply,
      onlyMissing: effectiveOnlyMissing(current.onlyMissing, round),
    };
  }

  /** Grava o progresso e fecha o job `canceled`, com a fase em que parou; nenhum lote novo é publicado. */
  private async stopped(
    { manager, current }: Locked,
    progress: JobColumns,
  ): Promise<CommitOutcome> {
    await updateJob(manager, current.id, {
      phase: current.phase,
      ...progress,
      status: 'canceled',
      clearHeartbeat: true,
      finish: true,
    });
    return 'committed';
  }

  /**
   * O que vem depois de fechar a fase: a próxima fase pedida e não pulada, ou, depois da última, a conferência final
   * (até 3 rodadas, somando ao `total` os itens que ainda se encaixam) ou o fim do job.
   */
  private async afterPhase(
    manager: EntityManager,
    job: FlyerProJob,
    phase: EnrichStep,
    result: FlyerProJob['result'],
  ) {
    const cursor = job.cursor ?? FRESH_CURSOR;
    const phases = runnablePhases(job.steps, result);
    const next = nextPhase(phases, phase);
    if (next)
      return {
        phase: next as EnrichPhase | null,
        cursor: reset(cursor),
        total: job.total,
        done: false,
      };
    const pending = await this.pendingCount(manager, job, phases);
    if (needsAnotherRound(cursor.round, pending)) {
      const again = { round: cursor.round + 1, pass: 0, position: null, id: null };
      return {
        phase: phases[0] as EnrichPhase | null,
        cursor: again,
        total: job.total + pending,
        done: false,
      };
    }
    return {
      phase: null as EnrichPhase | null,
      cursor: reset(cursor),
      total: job.total,
      done: true,
    };
  }

  /** Itens do escopo que ainda se encaixam em alguma fase pedida e não pulada, pelo critério de `onlyMissing` ligado. */
  private async pendingCount(
    manager: EntityManager,
    job: FlyerProJob,
    phases: EnrichStep[],
  ): Promise<number> {
    let pending = 0;
    for (const phase of phases) {
      pending += await countEligible(manager, {
        documentId: job.documentId,
        scope: job.itemIds,
        phase,
        onlyMissing: true,
      });
    }
    return pending;
  }

  /**
   * Publica o próximo lote com a ficha atual, na transação, num savepoint: se a fila falhar, só a publicação é desfeita,
   * os itens do lote ficam gravados e o job termina `failed` com `QUEUE_UNAVAILABLE`.
   */
  private async publishNext(locked: Locked, startAfterSeconds: number): Promise<void> {
    const { manager, current } = locked;
    const published = await inSavepoint(manager, 'flyer_pro_enrich_next', () =>
      this.queue.publish(
        QUEUES.FLYER_PRO_ENRICH,
        { jobId: current.id, seq: current.batchSeq },
        {
          manager,
          retryLimit: 0,
          expireInSeconds: this.config.batchExpireSeconds,
          ...(startAfterSeconds > 0 ? { startAfterSeconds } : {}),
        },
      ),
    );
    if (published.ok) return;
    this.logger.error(
      `Próximo lote do job ${current.id} não publicado: ${String(published.error)}`,
    );
    await updateJob(manager, current.id, failedColumns('QUEUE_UNAVAILABLE', current.phase, 0));
  }
}

const reset = (cursor: EnrichCursor): EnrichCursor => ({ ...cursor, position: null, id: null });

/** `done`: a fase zera e o job fecha. */
const doneColumns = (cursor: EnrichCursor): JobColumns => ({
  status: 'done',
  phase: null,
  cursor,
  finish: true,
});

/** `failed` com o `error` do código; a fase em que o job parou fica gravada. */
function failedColumns(
  code: EnrichErrorCode,
  phase: EnrichPhase | null,
  attempts: number,
): JobColumns {
  return {
    status: 'failed',
    phase,
    error: enrichError(code, phase),
    ...(attempts > 0 ? { batchAttempts: attempts } : {}),
    clearHeartbeat: true,
    finish: true,
  };
}

/** Aplica os `UPDATE` do lote; só o que afetou a linha conta (a condição do estado lido falhou: nada é gravado). */
async function applyWrites(manager: EntityManager, writes: ItemWrite[]): Promise<PhaseCounts> {
  const counts: PhaseCounts = {};
  for (const write of writes) {
    const [rows] = await manager.query(write.sql, write.params);
    if (rows?.length) counts[write.count] = (counts[write.count] ?? 0) + 1;
  }
  return counts;
}
