import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { FLYER_PRO_ENRICH_CONFIG, FlyerProEnrichConfig } from '../config/flyer-pro-enrich.config';
import { isActiveJobConflict, orderedSteps } from '../domain/flyer-pro-enrich-rules';
import {
  flyerProEnrichmentDisabled,
  flyerProEnrichmentRunning,
  flyerProMissingFields,
  flyerProNoItems,
} from '../domain/flyer-pro.errors';
import type { StartEnrichmentDto } from '../dto/start-enrichment.dto';
import type { FlyerProJob } from '../entities/flyer-pro-job.entity';
import { FlyerProJobView, toJobView } from '../views/flyer-pro-job.view';
import {
  cancelQueuedJob,
  findCurrentJob,
  findLatestJob,
  insertJob,
  lockActiveJob,
  requestJobStop,
} from './flyer-pro-job.statements';
import { hasItems, ItemScope, itemsOfDocument, totalOf } from './flyer-pro-job.scope';
import { assertLiveDocument, ITEMS_CURSOR_SQL, readWith } from './flyer-pro-read';
import { inSavepoint } from './flyer-pro-savepoint';

/** O que a criação de um job precisa: quem pede, o encarte, as fases e o escopo. */
export interface CreateJobInput {
  documentId: string;
  userId: string;
  steps: readonly string[];
  /** `null` vale "todos os itens do encarte". */
  itemIds: string[] | null;
  onlyMissing: boolean;
  autoApply: boolean;
}

/**
 * O job de enriquecimento do ponto de vista das rotas: iniciar (N14), ler (N15), parar (N16) e criar pelo salvar (N4).
 * Quem processa o job é o `FlyerProEnrichProcessor`; aqui só nasce, é lido e recebe o pedido de parada.
 */
@Injectable()
export class FlyerProJobsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: AnimationQueueService,
    @Inject(FLYER_PRO_ENRICH_CONFIG) private readonly config: FlyerProEnrichConfig,
  ) {}

  /**
   * N14, na ordem do contrato (o 401 e o 400 de forma vêm antes, do guard e do pipe): encarte vivo, flag do job,
   * escopo e, na inserção, o job ativo. O corpo `{}` o pipe pula, então `steps` é conferido à mão.
   */
  async start(
    userId: string,
    documentId: string,
    dto: StartEnrichmentDto,
  ): Promise<FlyerProJobView> {
    if (dto.steps === undefined) throw flyerProMissingFields(['steps']);
    try {
      return await this.dataSource.transaction(async (manager) => {
        await assertLiveDocument(manager, documentId);
        if (!this.config.enabled) throw flyerProEnrichmentDisabled();
        const job = await this.createJob(manager, {
          documentId,
          userId,
          steps: dto.steps,
          itemIds: dto.itemIds ?? null,
          onlyMissing: dto.onlyMissing ?? true,
          autoApply: dto.autoApply ?? true,
        });
        return this.viewOf(manager, job);
      });
    } catch (error) {
      // O `23505` aborta a transação em que ocorre: o job que ganhou é lido fora dela.
      if (!isActiveJobConflict(error)) throw error;
      throw await this.runningConflict(documentId);
    }
  }

  /** N15: o job ativo, senão o mais recente, senão `null`. Não grava nada. */
  async current(documentId: string): Promise<{ job: FlyerProJobView | null }> {
    return readWith(this.dataSource, undefined, async (manager) => {
      await assertLiveDocument(manager, documentId);
      return { job: await this.currentView(manager, documentId) };
    });
  }

  /**
   * N16, idempotente: `queued` vira `canceled` na hora; `running` grava o primeiro `cancelRequestedAt` e o lote em
   * execução fecha o job (sem lote em execução, um lote imediato com a ficha atual o fecha). Sem job ativo, `canceled:
   * false` com o mais recente ou `null`. Trava só a linha do job (A-23).
   */
  async cancel(documentId: string): Promise<{ canceled: boolean; job: FlyerProJobView | null }> {
    return this.dataSource.transaction(async (manager) => {
      await assertLiveDocument(manager, documentId);
      const active = await lockActiveJob(manager, documentId);
      if (!active) {
        const latest = await findLatestJob(manager, documentId);
        return { canceled: false, job: latest ? await this.viewOf(manager, latest) : null };
      }
      const job =
        active.status === 'queued'
          ? await cancelQueuedJob(manager, active.id)
          : await requestJobStop(manager, active.id);
      if (job.status === 'running' && !job.heartbeatAt) await this.publishImmediate(manager, job);
      return { canceled: true, job: await this.viewOf(manager, job) };
    });
  }

  /**
   * O lote imediato que fecha um job sem lote em execução: a mesma ficha, que o assume e vê o pedido. Se a fila falhar,
   * a resposta não muda e o reconciliador fecha o job na varredura.
   */
  private async publishImmediate(manager: EntityManager, job: FlyerProJob): Promise<void> {
    await inSavepoint(manager, 'flyer_pro_cancel_batch', () =>
      this.queue.publish(
        QUEUES.FLYER_PRO_ENRICH,
        { jobId: job.id, seq: job.batchSeq },
        { manager, retryLimit: 0, expireInSeconds: this.config.batchExpireSeconds },
      ),
    );
  }

  /**
   * O job que o encarte mostra (ativo, senão o mais recente) na forma de leitura, no `manager` de quem chama: o N3 e o
   * N4 o leem no próprio instantâneo ou transação.
   */
  async currentView(manager: EntityManager, documentId: string): Promise<FlyerProJobView | null> {
    const job = await findCurrentJob(manager, documentId);
    return job ? this.viewOf(manager, job) : null;
  }

  /**
   * Cria o job `queued` e publica o primeiro lote na mesma transação do `manager`: o worker só o vê depois do commit.
   * Escopo vazio é 422 `FLYER_PRO_NO_ITEMS`. A violação do índice de job ativo (`23505`) e a falha da fila sobem para
   * quem chama: o N14 as traduz, o N4 as perde num savepoint.
   */
  async createJob(manager: EntityManager, input: CreateJobInput): Promise<FlyerProJob> {
    const steps = orderedSteps(input.steps);
    const scope = await this.scopeOf(manager, input.documentId, input.itemIds);
    const total = await totalOf(manager, {
      documentId: input.documentId,
      scope,
      steps,
      onlyMissing: input.onlyMissing,
    });
    const job = await insertJob(manager, { ...input, steps, itemIds: scope, total });
    await this.queue.publish(
      QUEUES.FLYER_PRO_ENRICH,
      { jobId: job.id, seq: 0 },
      { manager, retryLimit: 0, expireInSeconds: this.config.batchExpireSeconds },
    );
    return job;
  }

  /** O job na forma de leitura, com o carimbo dos itens e o `stalled` do instante. */
  async viewOf(manager: EntityManager, job: FlyerProJob): Promise<FlyerProJobView> {
    const [{ cursor }] = await manager.query(ITEMS_CURSOR_SQL, [job.documentId]);
    return toJobView(job, cursor, new Date());
  }

  /** O escopo gravado: `null` (todos, e o encarte tem item) ou os ids pedidos que são do encarte; sem item, 422. */
  private async scopeOf(
    manager: EntityManager,
    documentId: string,
    requested: string[] | null,
  ): Promise<ItemScope> {
    if (requested === null) {
      if (!(await hasItems(manager, documentId))) throw flyerProNoItems();
      return null;
    }
    const own = await itemsOfDocument(manager, documentId, requested);
    if (own.length === 0) throw flyerProNoItems();
    return own;
  }

  /** O 409 do job ativo; se ele já terminou entre a violação e a leitura, vale o mais recente. */
  private async runningConflict(documentId: string) {
    const job = await readWith(this.dataSource, undefined, (manager) =>
      findCurrentJob(manager, documentId),
    );
    return flyerProEnrichmentRunning((job ?? (await this.latestOrFail(documentId))).id);
  }

  private latestOrFail(documentId: string): Promise<FlyerProJob> {
    return readWith(this.dataSource, undefined, async (manager) => {
      const job = await findLatestJob(manager, documentId);
      if (!job) throw new Error('Conflito de job ativo sem nenhum job no encarte');
      return job;
    });
  }
}
