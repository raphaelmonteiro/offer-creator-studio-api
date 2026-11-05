import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SceneTurnState } from '../processors/scene-turn-state';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneLockService } from './scene-lock.service';

/** Intervalo da varredura e tempo sem atividade para dar a versão por presa (PV-6). */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
export const STALE_AFTER_MS = 16 * 60 * 1000;

/**
 * Com `retryLimit: 0` um job que expira (worker reiniciado no meio) não volta. O reconciliador
 * marca `failed` com `JOB_EXPIRED` a versão `queued`/`running` sem atividade há mais de 16 minutos
 * (o job expira em 15) e deixa a mensagem de interrupção no chat. Nenhuma chamada paga é repetida.
 */
@Injectable()
export class SceneReconcilerService implements OnModuleDestroy {
  private readonly logger = new Logger(SceneReconcilerService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly locks: SceneLockService,
    private readonly state: SceneTurnState,
  ) {}

  /** No boot do worker e a cada 5 minutos. */
  start(): void {
    void this.safeReconcile();
    this.timer = setInterval(() => void this.safeReconcile(), RECONCILE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async safeReconcile(): Promise<void> {
    try {
      const expired = await this.reconcile();
      if (expired > 0)
        this.logger.warn(`${expired} versão(ões) de cena marcada(s) como JOB_EXPIRED`);
    } catch (error) {
      this.logger.error(`Reconciliação das cenas falhou: ${(error as Error).message}`);
    }
  }

  /** Quantas versões foram marcadas `JOB_EXPIRED` nesta passada. */
  async reconcile(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
    const stale = await this.dataSource
      .getRepository(TemplateSceneVersion)
      .createQueryBuilder('version')
      .select(['version.id', 'version.sceneId'])
      .where('version.status IN (:...busy)', { busy: ['queued', 'running'] })
      .andWhere('version.updatedAt < :cutoff', { cutoff })
      .getMany();
    let expired = 0;
    for (const { id, sceneId } of stale) {
      if (await this.expire(sceneId, id, cutoff)) expired += 1;
    }
    return expired;
  }

  private expire(sceneId: string, versionId: string, cutoff: Date): Promise<boolean> {
    return this.locks.run(
      sceneId,
      async ({ manager, scene }) => {
        const version = await manager.findOneBy(TemplateSceneVersion, { id: versionId });
        const busy = version?.status === 'queued' || version?.status === 'running';
        if (!version || !busy || version.updatedAt >= cutoff) return false;
        version.metrics = {
          ...version.metrics,
          // chamada paga que ficou sem resposta: o custo real é desconhecido
          costUnknown: (version.metrics.calls ?? []).some((call) => call.status === 'pending'),
          calls: (version.metrics.calls ?? []).map((call) =>
            call.status === 'pending'
              ? { ...call, status: 'failed' as const, errorCode: 'JOB_EXPIRED' }
              : call,
          ),
        };
        await this.state.failIn(manager, scene, version, 'JOB_EXPIRED');
        return true;
      },
      { includeDeleted: true },
    );
  }
}
