import { TerminalProviderError } from './provider-errors';

/**
 * Códigos e erro do modo de chamada da cena (`sceneCall` do `OpenAiImageService`). Ficam em `shared/`
 * para o módulo `template-scenes` classificar as falhas sem importar arquivos internos de `ai` (DT-12).
 */

/** Código de `TerminalProviderError` para tamanho, qualidade, fundo ou máscara recusados antes da rede. */
export const SCENE_INVALID_REQUEST_CODE = 'invalid_request';
/** Código de `TerminalProviderError` para conexão perdida DEPOIS de a requisição sair (pode ter sido cobrada). */
export const SCENE_CONNECTION_LOST_CODE = 'connection_lost';
/** Código de `TerminalProviderError` para resposta paga cuja imagem não pôde ser lida. */
export const SCENE_UNREADABLE_CODE = 'unreadable_response';
/** Código de `TerminalProviderError` para o timeout da requisição (não se repete chamada paga). */
export const SCENE_TIMEOUT_CODE = 'timeout';

/** A resposta foi paga, mas a imagem veio vazia/ilegível: leva o custo do `usage` para o chamador gravar. */
export class PaidResponseUnreadableError extends TerminalProviderError {
  constructor(
    message: string,
    readonly costUsd: number | null,
    readonly requestId: string | null,
  ) {
    super(message, SCENE_UNREADABLE_CODE);
  }
}
