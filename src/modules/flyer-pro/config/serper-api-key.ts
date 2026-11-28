import { ConfigService } from '@nestjs/config';
import { rawEnv } from './env-reader';

/**
 * A chave da Serper, só para quem monta o provedor real: fica fora de `PhotoSearchConfig` para nunca ser serializada
 * junto com a configuração (log, erro). Ausente ou vazia vale `undefined`; a API sobe assim.
 */
export function readSerperApiKey(config: ConfigService): string | undefined {
  return rawEnv(config, 'SERPER_API_KEY');
}
