import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProductReasoningEffort } from '../../ai/config/openai-chat-params';
import { readModelConfig } from '../../ai/config/openai-product-features.config';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';

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

type Warner = Pick<Logger, 'warn'>;

const EFFORTS: readonly ProductReasoningEffort[] = ['none', 'low', 'medium'];
const PREFIX = 'FLYER_PRO_STRUCTURE_AI_';

const rawOf = (config: ConfigService, name: string): string | undefined => {
  const raw = config.get<string>(PREFIX + name);
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text === '' ? undefined : text;
};

/** Inteiro de `min` a `max`; ausente vale o padrão em silêncio, valor inválido vale o padrão com aviso. */
function readInteger(
  config: ConfigService,
  logger: Warner,
  spec: { name: string; fallback: number; min: number; max?: number },
): number {
  const raw = rawOf(config, spec.name);
  if (raw === undefined) return spec.fallback;
  const parsed = Number(raw);
  const inRange =
    Number.isInteger(parsed) && parsed >= spec.min && parsed <= (spec.max ?? Infinity);
  if (inRange) return parsed;
  logger.warn(`${PREFIX}${spec.name}="${raw}" inválida; vale o padrão ${spec.fallback}`);
  return spec.fallback;
}

function readEffort(config: ConfigService, logger: Warner): ProductReasoningEffort {
  const raw = rawOf(config, 'EFFORT');
  if (raw === undefined) return 'low';
  if ((EFFORTS as readonly string[]).includes(raw)) return raw as ProductReasoningEffort;
  logger.warn(`${PREFIX}EFFORT="${raw}" inválido; vale "low"`);
  return 'low';
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
