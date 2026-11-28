import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rawEnv, readIntegerEnv, readProviderEnv, Warner } from './env-reader';

/** Token de injeção da configuração do job de enriquecimento, lida uma vez ao subir (mudar exige reiniciar). */
export const FLYER_PRO_ENRICH_CONFIG = 'FLYER_PRO_ENRICH_CONFIG';

export type EnrichProviderName = 'real' | 'mock';

export interface FlyerProEnrichConfig {
  /** Só `false` desliga o job. */
  enabled: boolean;
  provider: EnrichProviderName;
  /** Lotes simultâneos no worker. */
  concurrency: number;
  imageBatch: number;
  categoryBatch: number;
  spellBatch: number;
  /** Prazo do lote na fila (`expireInSeconds`). */
  batchExpireSeconds: number;
  /** Prazo da chamada ao provedor dentro do lote. */
  batchDeadlineMs: number;
  /** Lote em execução sem batimento por tanto tempo é dado por morto. */
  staleSeconds: number;
  /** Tentativas seguidas sem avanço antes de o job falhar. */
  maxAttempts: number;
}

const PREFIX = 'FLYER_PRO_ENRICH_';

/** As dez variáveis `FLYER_PRO_ENRICH_*`, com os padrões do requisito e um aviso por valor inválido. */
export function readEnrichConfig(
  config: ConfigService,
  logger: Warner = new Logger('FlyerProEnrichConfig'),
): FlyerProEnrichConfig {
  const integer = (name: string, fallback: number, multipleOf?: number) =>
    readIntegerEnv(config, logger, { name: PREFIX + name, fallback, min: 1, multipleOf });
  return {
    enabled: rawEnv(config, PREFIX + 'ENABLED') !== 'false',
    provider: readProviderEnv(config, logger, PREFIX + 'PROVIDER'),
    concurrency: integer('CONCURRENCY', 2),
    // Múltiplo de 8: cada chamada do leitor de nomes lê 8 nomes, e um lote de fotos usa chamadas inteiras.
    imageBatch: integer('IMAGE_BATCH', 16, 8),
    categoryBatch: integer('CATEGORY_BATCH', 40),
    spellBatch: integer('SPELL_BATCH', 40),
    batchExpireSeconds: integer('BATCH_EXPIRE_SECONDS', 300),
    batchDeadlineMs: integer('BATCH_DEADLINE_MS', 240_000),
    staleSeconds: integer('STALE_SECONDS', 60),
    maxAttempts: integer('MAX_ATTEMPTS', 3),
  };
}
