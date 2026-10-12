import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RenderPreflight } from '../../shared/ffmpeg/render-preflight';
import { SystemSettingsService } from '../../shared/settings/system-settings.service';
import {
  WORKER_HEARTBEAT_KEY,
  WorkerHeartbeat,
} from '../../shared/settings/worker-heartbeat.service';

/** Worker "saudável" = batimento há menos de 60s (4× o intervalo de 15s). */
export const WORKER_HEARTBEAT_STALE_MS = 60_000;

/**
 * Recorte do preflight de render exposto no health público: disponibilidade
 * por formato, motivo do que falta, versões dos binários. Fica de fora a lista
 * bruta de checagens e o caminho da fonte no disco (o health não tem auth).
 */
export type HealthRenderStatus = Pick<RenderPreflight, 'checkedAt' | 'formats' | 'details'> & {
  versions: Partial<Record<'ffmpeg' | 'ffprobe' | 'browser', string>>;
};

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource()
    private dataSource: DataSource,
    private readonly settings: SystemSettingsService,
  ) {}

  async check() {
    const dbStatus = await this.checkDatabase();
    const worker = await this.checkWorker();

    const status = {
      status: dbStatus ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbStatus ? 'connected' : 'disconnected',
      environment: process.env.NODE_ENV || 'development',
      version: process.env.APP_VERSION || 'dev',
      builtAt: process.env.APP_BUILT_AT || null,
      worker,
    };

    return {
      success: true,
      data: status,
    };
  }

  private async checkDatabase(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Heartbeat do worker (plano-comerciais §10 Fase 0: o deploy.sh só considera
   * o deploy OK com worker.healthy=true). Usa getFresh de propósito: o health
   * é exatamente o lugar que NÃO pode servir cache velho. Qualquer erro
   * (tabela ainda sem migration, banco fora) degrada para healthy=false em vez
   * de derrubar o endpoint.
   *
   * `render` expõe o preflight por formato publicado pelo worker (design D14):
   * `{ checkedAt, versions, formats: { scenes|talking_art|offer_carousel:
   * { available, missing[] } } }`, ou null enquanto o worker não o publicou.
   */
  private async checkWorker(): Promise<{
    lastSeenAt: string | null;
    healthy: boolean;
    render: HealthRenderStatus | null;
  }> {
    try {
      const heartbeat = await this.settings.getFresh<WorkerHeartbeat>(WORKER_HEARTBEAT_KEY);
      const lastSeenAt = heartbeat?.at ?? null;
      const healthy =
        lastSeenAt !== null && Date.now() - Date.parse(lastSeenAt) < WORKER_HEARTBEAT_STALE_MS;
      const render = heartbeat?.render
        ? {
            checkedAt: heartbeat.render.checkedAt,
            versions: {
              ffmpeg: heartbeat.render.versions?.ffmpeg,
              ffprobe: heartbeat.render.versions?.ffprobe,
              browser: heartbeat.render.versions?.browser,
            },
            details: heartbeat.render.details ?? {},
            formats: heartbeat.render.formats,
          }
        : null;
      return { lastSeenAt, healthy, render };
    } catch {
      return { lastSeenAt: null, healthy: false, render: null };
    }
  }
}
