import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as fs from 'fs/promises';
import { FalQueueClient, FalStatusResult } from '../../../shared/providers/fal-queue.client';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { MC_POLL_TIMEOUT_MS, mcExpireForQueue, mcPollBackoffS } from '../domain/mc-pipeline.config';
import { assertStepTransition, McStepStatus } from '../domain/mc-state-machines';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McPipelineService } from '../services/mc-pipeline.service';
import { McStorageService } from '../services/mc-storage.service';

/** Latência simulada do provider mock (a UI exercita o estado provider_wait). */
const MOCK_LATENCY_MS_DEFAULT = 4000;

export interface McPollPayload {
  stepId: string;
  attempt?: number;
  statusUrl?: string;
  responseUrl?: string;
}

/**
 * Consumer da fila mc.poll (conc. 10, NUNCA gated pelo ResourceGuard — plano
 * §6.4: poll parado = pipeline inteiro parado): consulta o status do job no
 * provider.
 *
 * - IN_QUEUE/IN_PROGRESS → reagenda com backoff 15/30/60s (cap) e timeout
 *   DURO de 15 min desde o início do step: estourou → failed classe
 *   `provider_timeout` + estorno do step + cena failed + projeto
 *   needs_attention (tudo via McPipelineService.failStep).
 * - COMPLETED → CAS provider_wait→ingesting + job mc.ingest (o download
 *   pesado NÃO roda aqui — a fila de ingest tem gate de recursos).
 *
 * singletonKey `poll:{stepId}:{attempt}` — a tentativa PRECISA estar na chave
 * (com `poll:{stepId}` fixo o pg-boss descarta o reagendamento enquanto este
 * job ainda está active e a cadeia morre — lição do módulo de animações).
 * As URLs de status/resultado viajam no payload e são reconstruíveis de
 * provider+providerJobId (queue.fal.run) se o payload se perder.
 */
@Injectable()
export class McPollProcessor {
  private readonly logger = new Logger(McPollProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pipeline: McPipelineService,
    private readonly transitions: TaskTransitionService,
    private readonly commercials: CommercialsService,
    private readonly queue: AnimationQueueService,
    private readonly fal: FalQueueClient,
    private readonly storage: McStorageService,
  ) {}

  async process(payload: McPollPayload): Promise<void> {
    const { stepId } = payload;
    const attempt = payload.attempt ?? 1;
    const step = await this.dataSource.getRepository(McStep).findOneBy({ id: stepId });
    // Fora de provider_wait = outro caminho já resolveu (ingest/falha/cancel) — no-op.
    if (!step || step.status !== McStepStatus.PROVIDER_WAIT) return;

    // Timeout DURO por step (plano §6.4: teto de vídeo/lipsync 15 min).
    const startedAt = step.startedAt ? new Date(step.startedAt).getTime() : Date.now();
    if (Date.now() - startedAt > MC_POLL_TIMEOUT_MS) {
      await this.pipeline.failStep(
        step,
        McStepStatus.PROVIDER_WAIT,
        new Error(`Provider excedeu o teto de ${MC_POLL_TIMEOUT_MS / 60000} min`),
        { errorClass: 'provider_timeout', fallbackCode: 'provider_timeout' },
      );
      return;
    }

    try {
      const status =
        step.provider === 'mock'
          ? await this.mockStatus(step.providerJobId as string)
          : await this.fal.status(payload.statusUrl ?? this.defaultStatusUrl(step));

      if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') {
        await this.reschedule(payload, attempt);
        return;
      }

      // COMPLETED → ingesting + job de download na fila com gate de recursos.
      await this.dataSource.transaction(async (manager) => {
        assertStepTransition(McStepStatus.PROVIDER_WAIT, McStepStatus.INGESTING);
        const won = await this.transitions.casTransition(
          manager,
          McStep,
          stepId,
          McStepStatus.PROVIDER_WAIT,
          McStepStatus.INGESTING,
        );
        if (!won) return;
        const project = await manager.findOneByOrFail(McProject, { id: step.projectId });
        await this.commercials.appendEvent(manager, {
          userId: project.userId,
          refKind: 'step',
          refId: stepId,
          kind: 'transition',
          fromStatus: McStepStatus.PROVIDER_WAIT,
          toStatus: McStepStatus.INGESTING,
          detail: { type: step.type, attempt },
        });
        await this.pipeline.notifyStep(manager, project.userId, step, McStepStatus.INGESTING);
        await this.queue.publish(
          QUEUES.MC_INGEST,
          { stepId, responseUrl: payload.responseUrl ?? this.defaultResponseUrl(step) },
          { expireInSeconds: mcExpireForQueue(QUEUES.MC_INGEST) },
        );
      });
    } catch (err) {
      if (err instanceof TerminalProviderError) {
        await this.pipeline.failStep(step, McStepStatus.PROVIDER_WAIT, err, {
          fallbackCode: 'poll_failed',
        });
        return;
      }
      // Transiente (rede/5xx): reagendar É o retry — o teto duro de 15 min limita.
      this.logger.warn(`Poll ${stepId} transiente: ${(err as Error).message} — reagendando`);
      await this.reschedule(payload, attempt);
    }
  }

  private async reschedule(payload: McPollPayload, attempt: number): Promise<void> {
    await this.queue.publish(
      QUEUES.MC_POLL,
      { ...payload, attempt: attempt + 1 },
      {
        startAfterSeconds: mcPollBackoffS(attempt),
        singletonKey: `poll:${payload.stepId}:${attempt + 1}`,
        expireInSeconds: mcExpireForQueue(QUEUES.MC_POLL),
      },
    );
  }

  /** Reconstrução determinística das URLs da fila fal (provider = modelo, jobId = request_id). */
  private defaultStatusUrl(step: McStep): string {
    return `https://queue.fal.run/${step.provider}/requests/${step.providerJobId}/status`;
  }

  private defaultResponseUrl(step: McStep): string {
    return `https://queue.fal.run/${step.provider}/requests/${step.providerJobId}`;
  }

  /** Mock: o clipe existe em mock-jobs/ e "fica pronto" após a latência simulada. */
  private async mockStatus(jobId: string): Promise<FalStatusResult> {
    const latency = Number(process.env.MC_PIPELINE_MOCK_LATENCY_MS ?? MOCK_LATENCY_MS_DEFAULT);
    try {
      const stat = await fs.stat(this.storage.mockJobAbsPath(jobId));
      if (Date.now() - stat.mtimeMs < latency) return { status: 'IN_PROGRESS' };
      return { status: 'COMPLETED' };
    } catch {
      throw new TerminalProviderError('Job mock não encontrado no disco', 'mock_job_missing');
    }
  }
}
