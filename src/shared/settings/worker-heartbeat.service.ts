import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SystemSettingsService } from './system-settings.service';

/** Chave do heartbeat em system_settings — lida pelo /v1/health e pelo deploy.sh. */
export const WORKER_HEARTBEAT_KEY = 'worker_heartbeat';

/** Batimento a cada 15s; o health considera morto após 60s sem batimento. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;

export interface WorkerHeartbeat {
  at: string; // ISO-8601
  pid: number;
}

/**
 * Heartbeat do worker (plano-comerciais §10, Fase 0: "deploy falha sem
 * batimento"). SOMENTE no processo worker (WORKER_ONLY=true): grava
 * `worker_heartbeat` em system_settings a cada 15s, com primeiro batimento
 * imediato no boot — é isso que permite ao deploy.sh esperar o coração bater
 * logo após o `pm2 restart` sem depender do intervalo cheio.
 *
 * O timer é unref()'d (não segura o processo vivo) e cada batimento engole o
 * próprio erro: um Postgres piscando não pode derrubar o worker — o efeito
 * visível é o /v1/health reportar worker.healthy=false até o próximo acerto.
 */
@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly settings: SystemSettingsService) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKER_ONLY !== 'true') return; // só o worker bate o coração
    await this.beat(); // primeiro batimento imediato
    this.timer = setInterval(() => void this.beat(), WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async beat(): Promise<void> {
    try {
      const heartbeat: WorkerHeartbeat = { at: new Date().toISOString(), pid: process.pid };
      await this.settings.set(WORKER_HEARTBEAT_KEY, heartbeat);
    } catch (err) {
      this.logger.warn(`Heartbeat falhou: ${(err as Error).message}`);
    }
  }
}
