import { classifyOpenAiErrorStrict } from '../../../shared/providers/openai-errors';

/**
 * Chama um serviço de IA e sobe a falha classificada pelo modo estrito da change 28: limite de taxa, 5xx, rede e prazo
 * são transitórios; chave inválida, conta sem crédito e pedido recusado, terminais; erro sem status (resposta inválida
 * que sobrou depois das novas tentativas do serviço) é transitório (A-7). O processador do job repete ou termina o job
 * pelo tipo do erro.
 */
export async function strictCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw classifyOpenAiErrorStrict(error);
  }
}
