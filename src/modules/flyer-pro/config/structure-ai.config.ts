import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProductReasoningEffort } from '../../ai/config/openai-chat-params';
import { readModelConfig } from '../../ai/config/openai-product-features.config';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { rawEnv, readIntegerEnv, Warner } from './env-reader';

/** Token de injeção da configuração da sugestão de estrutura, lida uma vez ao subir (mudar exige reiniciar). */
export const STRUCTURE_AI_CONFIG = 'FLYER_PRO_STRUCTURE_AI_CONFIG';

export type StructureAiProviderName = 'real' | 'mock';

export interface StructureAiConfig {
  /** Só `false` desliga a rota. */
  enabled: boolean;
  provider: StructureAiProviderName;
  model: string;
  effort: ProductReasoningEffort;
  timeoutMs: number;
  maxPerHour: number;
  maxHeroes: number;
  /** Encartes anteriores do cliente usados como exemplo (0 desliga a leitura). */
  examples: number;
}

const EFFORTS: readonly ProductReasoningEffort[] = ['none', 'low', 'medium'];
const PREFIX = 'FLYER_PRO_STRUCTURE_AI_';

const rawOf = (config: ConfigService, name: string): string | undefined =>
  rawEnv(config, PREFIX + name);

/** Inteiro de `min` a `max` de uma variável `FLYER_PRO_STRUCTURE_AI_*`; o aviso traz o nome inteiro e o valor recebido. */
const readInteger = (
  config: ConfigService,
  logger: Warner,
  spec: { name: string; fallback: number; min: number; max?: number },
): number => readIntegerEnv(config, logger, { ...spec, name: PREFIX + spec.name });

/** O esforço padrão da sugestão (D-6 (b) da change 45); o valor inválido cai nele, com aviso (A-19). */
const DEFAULT_EFFORT: ProductReasoningEffort = 'medium';

function readEffort(config: ConfigService, logger: Warner): ProductReasoningEffort {
  const raw = rawOf(config, 'EFFORT');
  if (raw === undefined) return DEFAULT_EFFORT;
  if ((EFFORTS as readonly string[]).includes(raw)) return raw as ProductReasoningEffort;
  logger.warn(`${PREFIX}EFFORT="${raw}" inválido; vale "${DEFAULT_EFFORT}"`);
  return DEFAULT_EFFORT;
}

function readProvider(config: ConfigService, logger: Warner): StructureAiProviderName {
  const raw = rawOf(config, 'PROVIDER');
  if (raw === undefined || raw === 'real') return 'real';
  if (raw !== 'mock') logger.warn(`${PREFIX}PROVIDER="${raw}" desconhecido; provedor em mock`);
  return 'mock';
}

/** As oito variáveis `FLYER_PRO_STRUCTURE_AI_*`, com os padrões do contrato e um aviso por valor inválido. */
export function readStructureAiConfig(
  config: ConfigService,
  logger: Warner = new Logger('FlyerProStructureAiConfig'),
): StructureAiConfig {
  const limits = FLYER_PRO_LIMITS;
  return {
    enabled: rawOf(config, 'ENABLED') !== 'false',
    provider: readProvider(config, logger),
    model: readModelConfig(config, PREFIX + 'MODEL', 'gpt-6-luna'),
    effort: readEffort(config, logger),
    timeoutMs: readInteger(config, logger, {
      name: 'TIMEOUT_MS',
      fallback: limits.structureTimeoutMsDefault,
      min: 1,
    }),
    maxPerHour: readInteger(config, logger, {
      name: 'MAX_PER_HOUR',
      fallback: limits.structureMaxPerHourDefault,
      min: 1,
    }),
    maxHeroes: readInteger(config, logger, {
      name: 'MAX_HEROES',
      fallback: limits.structureMaxHeroesDefault,
      min: 1,
    }),
    examples: readInteger(config, logger, {
      name: 'EXAMPLES',
      fallback: limits.structureExamplesDefault,
      min: 0,
      max: limits.structureExamplesReadMax,
    }),
  };
}
