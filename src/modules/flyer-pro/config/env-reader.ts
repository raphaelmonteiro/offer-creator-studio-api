import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Leitura de variáveis de ambiente do módulo, com padrão e aviso por valor inválido (sem derrubar a subida). */

export type Warner = Pick<Logger, 'warn'>;

/** O texto aparado da variável, ou `undefined` se ausente ou vazia. */
export function rawEnv(config: ConfigService, name: string): string | undefined {
  const raw = config.get<string>(name);
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text === '' ? undefined : text;
}

export interface IntegerSpec {
  /** O nome inteiro da variável, com o prefixo. */
  name: string;
  fallback: number;
  min: number;
  max?: number;
  /** Só vale o valor que é múltiplo deste número (o lote de fotos usa chamadas inteiras de 8 nomes). */
  multipleOf?: number;
}

/** Inteiro de `min` a `max`; ausente vale o padrão em silêncio, valor inválido vale o padrão com aviso (nome e valor). */
export function readIntegerEnv(config: ConfigService, logger: Warner, spec: IntegerSpec): number {
  const raw = rawEnv(config, spec.name);
  if (raw === undefined) return spec.fallback;
  const parsed = Number(raw);
  const valid =
    Number.isInteger(parsed) &&
    parsed >= spec.min &&
    parsed <= (spec.max ?? Infinity) &&
    parsed % (spec.multipleOf ?? 1) === 0;
  if (valid) return parsed;
  logger.warn(`${spec.name}="${raw}" inválida; vale o padrão ${spec.fallback}`);
  return spec.fallback;
}
