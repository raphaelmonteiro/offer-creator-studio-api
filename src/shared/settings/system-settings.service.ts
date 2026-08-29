import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from './system-setting.entity';

/** TTL do cache em memória por chave — flags operacionais toleram 10s de atraso. */
export const SETTINGS_CACHE_TTL_MS = 10_000;

interface CacheEntry {
  value: unknown;
  cachedAt: number;
}

/**
 * Configuração operacional em banco (plano-comerciais §6.7): kill-switch
 * 'mc_paused', heartbeat 'worker_heartbeat' etc.
 *
 * `get` serve do cache local por até 10s (uma checagem por request de enqueue
 * não pode custar um SELECT sempre); `getFresh` vai direto ao banco (health
 * não pode servir cache velho); `set` faz upsert e invalida o cache LOCAL —
 * outros processos (API × worker) convergem sozinhos quando o TTL expira.
 */
@Injectable()
export class SystemSettingsService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    @InjectRepository(SystemSetting)
    private readonly repo: Repository<SystemSetting>,
  ) {}

  /** Leitura com cache de 10s por chave (ausência de linha também é cacheada). */
  async get<T>(key: string): Promise<T | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.cachedAt < SETTINGS_CACHE_TTL_MS) {
      return hit.value as T | null;
    }
    const value = await this.getFresh<T>(key);
    this.cache.set(key, { value, cachedAt: Date.now() });
    return value;
  }

  /** Leitura direta do banco, sem cache — usada pelo /v1/health. */
  async getFresh<T>(key: string): Promise<T | null> {
    const row = await this.repo.findOneBy({ key });
    return row ? (row.value as T) : null;
  }

  /**
   * Upsert (INSERT ... ON CONFLICT) com `updatedAt = now()` também no update —
   * SQL cru porque o default now() da coluna só vale no INSERT. Invalida o
   * cache local da chave na sequência.
   */
  async set(key: string, value: unknown): Promise<void> {
    await this.repo.query(
      `INSERT INTO "system_settings" ("key", "value", "updatedAt")
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()`,
      [key, JSON.stringify(value)],
    );
    this.cache.delete(key);
  }
}
