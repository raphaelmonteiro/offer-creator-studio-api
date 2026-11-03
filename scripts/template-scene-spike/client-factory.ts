import type { SpikeConfig } from './config';
import { FakeOpenAi } from './fake-openai';
import { RealOpenAi } from './openai-client';
import type { SpikeOpenAi } from './openai-client';

/**
 * Sem `--confirm-spend` o cliente é o falso (nenhuma requisição sai). Com a confirmação, a chave tem
 * de existir: a mensagem nomeia a variável, nunca o valor.
 */
export function createClient(config: SpikeConfig, confirmSpend: boolean): SpikeOpenAi {
  if (!confirmSpend) return new FakeOpenAi();
  if (!config.openaiKey) {
    throw new Error('OPENAI_API_KEY ausente ou vazia em backend/.env: nenhuma chamada foi feita');
  }
  return new RealOpenAi(config.openaiKey);
}
