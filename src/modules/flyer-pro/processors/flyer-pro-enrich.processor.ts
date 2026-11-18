import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { AiUsageCollector } from '../../ai/utils/ai-usage';
import { FLYER_PRO_ENRICH_CONFIG, FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import {
  batchSizeOf,
  effectiveOnlyMissing,
  HEARTBEAT_INTERVAL_MS,
  nextPhase,
  runnablePhases,
} from '../domain/flyer-pro-enrich-rules';
import type { EnrichStep } from '../domain/flyer-pro-job.types';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import {
  EnrichCallContext,
  FLYER_PRO_ENRICH_PORT,
  FlyerProEnrichPort,
} from '../providers/flyer-pro-enrich.port';
import { countEligible } from '../services/flyer-pro-job.scope';
import { BatchFailure, FlyerProEnrichCommitter } from './flyer-pro-enrich.committer';
import { beat, claimBatch, readBatch } from './flyer-pro-enrich.statements';
import type { BatchMessage, EnrichItemRow, PhaseWork, UnitPlan } from './flyer-pro-enrich.types';

/** O prazo da chamada ao provedor estourou: falha transitória `AI_TIMEOUT`. */
export class ProviderDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`A chamada ao provedor passou do prazo de ${deadlineMs} ms`);
  }
}

/**
 * Corre a chamada contra o prazo; o que chegar depois do prazo é descartado (e a rejeição tardia é engolida). Falha ou
 * prazo estourado abortam `controller`: o provedor real cancela as chamadas em andamento em vez de deixá-las correr
 * pagas (o lote será repetido, ou o job termina).
 */
async function withDeadline<T>(
  work: Promise<T>,
  deadlineMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderDeadlineError(deadlineMs)), deadlineMs);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** A falha do provedor (ou do prazo) como o job a registra; `null` para qualquer outro erro, que vira `INTERNAL`. */
export function classifyBatchError(error: unknown): BatchFailure | null {
  if (error instanceof ProviderDeadlineError) return { code: 'AI_TIMEOUT', terminal: false };
  if (error instanceof TransientProviderError)
    return { code: 'AI_PROVIDER_ERROR', terminal: false };
  if (error instanceof TerminalProviderError) return { code: 'AI_PROVIDER_ERROR', terminal: true };
  return null;
}

/** O encarte do job, lido sem trava: o nome e o cliente vão ao provedor; `null` se a linha sumiu. */
interface DocumentFacts {
  name: string;
  clientId: string;
  deletedAt: Date | null;
}

/** O que a mensagem em andamento já sabe, para o log e a falha dizerem o fase, os itens e quanto levou. */
interface Progress {
  phase: EnrichStep | null;
  items: number;
  startedAt: number;
  providerStartedAt: number | null;
}

/**
 * O consumidor de um lote do job (fila `flyer_pro.enrich`): assume a ficha, liga o batimento, lê o próximo lote da fase,
 * chama a porta do provedor fora de transação, com prazo, e grava (ver `FlyerProEnrichCommitter`). Uma mensagem faz uma
 * coisa só: parar, pular a fase, fechar a fase sem item ou processar um lote. Depois de assumir a ficha nunca lança: todo
 * erro vira estado do job no banco (regra de ouro de `a3-job-enriquecimento.html#s7-3`).
 */
@Injectable()
export class FlyerProEnrichProcessor {
  private readonly logger = new Logger(FlyerProEnrichProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly committer: FlyerProEnrichCommitter,
    @Inject(FLYER_PRO_ENRICH_PORT) private readonly port: FlyerProEnrichPort,
    @Inject(FLYER_PRO_ENRICH_CONFIG) private readonly config: FlyerProEnrichConfig,
  ) {}

  async handle(message: BatchMessage): Promise<void> {
    const startedAt = Date.now();
    const job = await claimBatch(this.dataSource, message.jobId, message.seq);
    if (!job) return;
    const progress: Progress = { phase: null, items: 0, startedAt, providerStartedAt: null };
    const stopBeating = this.startHeartbeat(job);
    try {
      await this.run(job, progress);
    } catch (error) {
      await this.fail(job, progress, error);
    } finally {
      stopBeating();
    }
  }

  /** O batimento a cada 15 s, só enquanto a ficha do lote for a atual e o job estiver `running`. */
  private startHeartbeat(job: FlyerProJob): () => void {
    const timer = setInterval(() => {
      beat(this.dataSource, job.id, job.batchSeq).catch((error: unknown) =>
        this.logger.warn(`Batimento do job ${job.id} falhou: ${String(error)}`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }

  private async run(job: FlyerProJob, progress: Progress): Promise<void> {
    const phase = this.phaseOf(job);
    if (!phase) throw new Error('Job ativo sem nenhuma fase a rodar');
    progress.phase = phase;
    const document = await this.documentOf(job);
    if (!document || document.deletedAt !== null || job.cancelRequestedAt) {
      await this.committer.cancelClaimed(job);
      return;
    }
    const items = await this.read(job, phase);
    progress.items = items.length;
    const plan = await this.plan({ job, phase, items, document, progress });
    const outcome = await this.committer.commitUnit(job, plan);
    if (plan.work) {
      this.logBatch(
        job,
        progress,
        plan.providerMs,
        outcome === 'committed' ? 'gravado' : 'descartado',
      );
    }
  }

  /** A fase em andamento: a que o job guarda, ou a primeira das fases pedidas num job novo. */
  private phaseOf(job: FlyerProJob): EnrichStep | null {
    if (job.phase) return job.phase as EnrichStep;
    return nextPhase(runnablePhases(job.steps, job.result ?? {}), null);
  }

  /** O que esta mensagem faz: fecha a fase sem item, pula a fase indisponível ou chama o provedor para o lote. */
  private async plan(input: {
    job: FlyerProJob;
    phase: EnrichStep;
    items: EnrichItemRow[];
    document: DocumentFacts;
    progress: Progress;
  }): Promise<UnitPlan> {
    const { job, phase, items, progress } = input;
    const base = this.basePlan(phase, progress.startedAt);
    if (items.length === 0) return base;
    if (!this.port.isAvailable(phase))
      return { ...base, skipped: true, skippedItems: await this.remaining(job, phase) };
    progress.providerStartedAt = Date.now();
    const controller = new AbortController();
    const context = this.contextOf(job, input.document, controller.signal);
    const work = await withDeadline(
      this.callPort(phase, items, context),
      this.config.batchDeadlineMs,
      controller,
    );
    return {
      ...base,
      work,
      batchSize: batchSizeOf(phase, this.config),
      model: this.port.modelOf(phase),
      totalMs: Date.now() - progress.startedAt,
      providerMs: Date.now() - progress.providerStartedAt,
    };
  }

  private basePlan(phase: EnrichStep, startedAt: number): UnitPlan {
    return {
      phase,
      work: null,
      batchSize: 1,
      skipped: false,
      skippedItems: 0,
      model: null,
      totalMs: Date.now() - startedAt,
      providerMs: 0,
    };
  }

  private callPort(
    phase: EnrichStep,
    items: EnrichItemRow[],
    context: EnrichCallContext,
  ): Promise<PhaseWork> {
    if (phase === 'categorize') {
      return this.port.categorize(items, context).then((verdicts) => ({ phase, items, verdicts }));
    }
    if (phase === 'spellcheck') {
      return this.port.spellcheck(items, context).then((verdicts) => ({ phase, items, verdicts }));
    }
    return this.port.matchImages(items, context).then((verdicts) => ({ phase, items, verdicts }));
  }

  /** Os itens que a fase pegaria daqui em diante: um pulo os dá por visitados, para `processed` chegar a `total`. */
  private remaining(job: FlyerProJob, phase: EnrichStep): Promise<number> {
    return countEligible(this.dataSource.manager, {
      documentId: job.documentId,
      scope: job.itemIds ?? null,
      phase,
      onlyMissing: effectiveOnlyMissing(job.onlyMissing, job.cursor?.round ?? 1),
    });
  }

  private read(job: FlyerProJob, phase: EnrichStep): Promise<EnrichItemRow[]> {
    const cursor = job.cursor;
    return readBatch(this.dataSource.manager, {
      documentId: job.documentId,
      itemIds: job.itemIds ?? null,
      phase,
      onlyMissing: effectiveOnlyMissing(job.onlyMissing, cursor?.round ?? 1),
      size: batchSizeOf(phase, this.config),
      after: cursor?.id ? { position: cursor.position as number, id: cursor.id } : null,
    });
  }

  private async documentOf(job: FlyerProJob): Promise<DocumentFacts | null> {
    const rows: DocumentFacts[] = await this.dataSource.query(
      `SELECT "name", "clientId", "deletedAt" FROM "flyer_pro_documents" WHERE "id" = $1`,
      [job.documentId],
    );
    return rows[0] ?? null;
  }

  private contextOf(
    job: FlyerProJob,
    document: DocumentFacts,
    signal: AbortSignal,
  ): EnrichCallContext {
    return {
      jobId: job.id,
      documentName: document.name,
      clientId: document.clientId,
      usage: new AiUsageCollector(),
      signal,
      pass: 0,
      notes: { nameSearchUnavailable: false },
    };
  }

  /**
   * Uma linha por lote que chamou o provedor: job, fase, itens, duração total (de assumir a ficha a gravar) e só da
   * chamada, em ms, e o resultado. Nunca chave, segredo nem o conteúdo dos itens.
   */
  private logBatch(
    job: FlyerProJob,
    progress: Progress,
    providerMs: number,
    outcome: string,
  ): void {
    const line = {
      jobId: job.id,
      phase: progress.phase,
      items: progress.items,
      totalMs: Date.now() - progress.startedAt,
      providerMs,
      outcome,
    };
    this.logger.log(`Lote do job ${JSON.stringify(line)}`);
  }

  /** Falha depois de assumir a ficha: do provedor (repete ou termina o job) ou inesperada (`INTERNAL`). Nunca lança. */
  private async fail(job: FlyerProJob, progress: Progress, error: unknown): Promise<void> {
    try {
      const failure = classifyBatchError(error);
      if (failure && progress.phase) {
        await this.committer.commitFailure(job, progress.phase, failure);
        const providerMs = Date.now() - (progress.providerStartedAt ?? progress.startedAt);
        this.logBatch(job, progress, providerMs, `falhou ${failure.code}`);
        return;
      }
      this.logger.error(
        `Erro inesperado no lote do job ${job.id}: ${String(error)}`,
        (error as Error)?.stack,
      );
      await this.committer.failUnexpected(job, progress.phase);
    } catch (inner) {
      this.logger.error(`Não foi possível registrar a falha do job ${job.id}: ${String(inner)}`);
    }
  }
}
