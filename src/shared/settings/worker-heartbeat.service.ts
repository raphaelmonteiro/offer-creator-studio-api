import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RenderPreflight } from '../ffmpeg/render-preflight';
import { RenderPreflightService } from '../ffmpeg/render-preflight.service';
import { SystemSettingsService } from './system-settings.service';

/** Chave do heartbeat em system_settings — lida pelo /v1/health e pelo deploy.sh. */
export const WORKER_HEARTBEAT_KEY = 'worker_heartbeat';

/** Batimento a cada 15s; o health considera morto após 60s sem batimento. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;

/** Preflight de render refeito a cada hora (design D14) — binários não mudam com frequência. */
export const RENDER_PREFLIGHT_INTERVAL_MS = 60 * 60_000;

export interface WorkerHeartbeat {
  at: string; // ISO-8601
  pid: number;
  /** Último preflight de render do worker (ausente enquanto o worker não o concluiu). */
  render?: RenderPreflight;
}

/**
 * Heartbeat do worker (plano-comerciais §10, Fase 0: "deploy falha sem
 * batimento"). SOMENTE no processo worker (WORKER_ONLY=true): grava
 * `worker_heartbeat` em system_settings a cada 15s, com primeiro batimento
 * imediato no boot — é isso que permite ao deploy.sh esperar o coração bater
 * logo após o `pm2 restart` sem depender do intervalo cheio.
 *
 * O batimento carrega o preflight de render por formato (design D14): feito
 * no boot, antes do primeiro batimento, e refeito a cada hora. Falha do
 * preflight não impede o batimento — o health mostra `render` ausente.
 *
 * Os timers são unref()'d (não seguram o processo vivo) e cada batimento
 * engole o próprio erro: um Postgres piscando não pode derrubar o worker — o
 * efeito visível é o /v1/health reportar worker.healthy=false até o próximo acerto.
 */
@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer: NodeJS.Timeout | null = null;
  private preflightTimer: NodeJS.Timeout | null = null;
  private render: RenderPreflight | undefined;

  constructor(
    private readonly settings: SystemSettingsService,
    private readonly preflight: RenderPreflightService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.WORKER_ONLY !== 'true') return; // só o worker bate o coração
    await this.refreshPreflight();
    await this.beat(); // primeiro batimento imediato, já com o preflight
    this.timer = setInterval(() => void this.beat(), WORKER_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    this.preflightTimer = setInterval(
      () => void this.refreshPreflight(),
      RENDER_PREFLIGHT_INTERVAL_MS,
    );
    this.preflightTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.preflightTimer) clearInterval(this.preflightTimer);
  }

  /** Último preflight conhecido deste processo (para testes e diagnóstico). */
  lastPreflight(): RenderPreflight | undefined {
    return this.render;
  }

  private async refreshPreflight(): Promise<void> {
    try {
      this.render = await this.preflight.run();
    } catch (err) {
      this.logger.warn(`Preflight de render falhou: ${(err as Error).message}`);
    }
  }

  private async beat(): Promise<void> {
    try {
      const heartbeat: WorkerHeartbeat = { at: new Date().toISOString(), pid: process.pid };
      if (this.render) heartbeat.render = this.render;
      await this.settings.set(WORKER_HEARTBEAT_KEY, heartbeat);
    } catch (err) {
      this.logger.warn(`Heartbeat falhou: ${(err as Error).message}`);
    }
  }
}
