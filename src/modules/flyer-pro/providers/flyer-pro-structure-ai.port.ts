import type { StructureAiRequest, StructureAiResult } from '../domain/structure-ai-request';
import type {
  StructureAiDisabledReason,
  StructureAiFailureReason,
} from '../domain/flyer-pro.errors';

/** Token de injeção do provedor da sugestão de estrutura (`mock` ou `real`, escolhido por variável ao subir). */
export const FLYER_PRO_STRUCTURE_AI_PORT = 'FLYER_PRO_STRUCTURE_AI_PORT';

/** O que a chamada leva: o prazo dela. */
export interface StructureAiCallOptions {
  timeoutMs: number;
}

/**
 * O provedor da sugestão: devolve a proposta bruta, com apelidos, o modelo que respondeu e os tokens. Falha do provedor,
 * prazo ou saída fora do schema são `StructureAiFailure`; qualquer outro erro lançado vale `PROVIDER_ERROR`. Nunca devolve
 * sugestão de reserva.
 */
export interface FlyerProStructureAiPort {
  /** `ai` (OpenAI) ou `mock` (simulado, sem rede e sem custo): vai na resposta como `source`. */
  readonly source: 'ai' | 'mock';
  /** Por que o provedor não pode ser chamado agora (sem chave, modelo sem preço), ou `null`. O simulado nunca depende de nada. */
  unavailableReason(): Exclude<StructureAiDisabledReason, 'FLAG'> | null;
  suggest(request: StructureAiRequest, options: StructureAiCallOptions): Promise<StructureAiResult>;
}

/** Falha do provedor com o motivo que o 503 devolve. */
export class StructureAiFailure extends Error {
  constructor(
    readonly reason: StructureAiFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'StructureAiFailure';
  }
}
