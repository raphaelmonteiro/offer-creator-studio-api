import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { StructureAiConfig } from '../config/structure-ai.config';
import { MockFlyerProStructureAi } from './flyer-pro-structure-ai.mock';
import type { FlyerProStructureAiPort } from './flyer-pro-structure-ai.port';
import { RealFlyerProStructureAi } from './flyer-pro-structure-ai.real';

/**
 * Escolhe o provedor por `FLYER_PRO_STRUCTURE_AI_PROVIDER` (já resolvido em `real` ou `mock` pela configuração, que avisa
 * no log do valor desconhecido). O `real` sobe mesmo sem `OPENAI_API_KEY`, com um aviso: a rota responde 422 `NO_API_KEY`
 * até a chave existir, e a API nunca falha ao subir.
 */
export function createStructureAiPort(
  config: StructureAiConfig,
  configService: ConfigService,
  logger: Pick<Logger, 'warn'> = new Logger('FlyerProStructureAi'),
): FlyerProStructureAiPort {
  if (config.provider === 'mock') return new MockFlyerProStructureAi();
  const apiKey = configService.get<string>('OPENAI_API_KEY');
  if (!apiKey) {
    logger.warn(
      'FLYER_PRO_STRUCTURE_AI_PROVIDER=real sem OPENAI_API_KEY: a sugestão de estrutura responde 422 NO_API_KEY',
    );
  }
  return new RealFlyerProStructureAi(config, apiKey ? new OpenAI({ apiKey }) : null);
}
