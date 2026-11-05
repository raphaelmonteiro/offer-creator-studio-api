import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import {
  isPreRequestNetworkError,
  TerminalProviderError,
} from '../../shared/providers/provider-errors';
import { OPENAI_NO_SDK_RETRY } from '../../shared/providers/openai-errors';
import {
  estimateCostUsd,
  ImageUsage,
  validateImageQuality,
  validateImageSize,
} from './config/openai-image-capabilities';

/**
 * Modo de chamada da cena (change add-template-scene-persistence): quota terminal, sem retentativa
 * do SDK, timeout por requisição, `usage`/`requestId`/custo no retorno e tamanho validado pela
 * tabela de capacidades. Sem `sceneCall`, o `OpenAiImageService` segue exatamente como antes.
 */
export interface SceneCallOptions {
  /** Timeout desta requisição (não é global: os outros chamadores mantêm o timeout do SDK). */
  timeoutMs: number;
  /** Liga as linhas de log da chamada à cena e à versão. */
  correlationId: string;
}

/** Código de `TerminalProviderError` para tamanho ou qualidade recusados pela tabela. */
export const SCENE_INVALID_REQUEST_CODE = 'invalid_request';
/** Código de `TerminalProviderError` para conexão perdida DEPOIS de a requisição sair (pode ter sido cobrada). */
export const SCENE_CONNECTION_LOST_CODE = 'connection_lost';
/** Código de `TerminalProviderError` para resposta paga cuja imagem não pôde ser lida. */
export const SCENE_UNREADABLE_CODE = 'unreadable_response';

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

/** Código de `TerminalProviderError` para o timeout da requisição (não se repete chamada paga). */
export const SCENE_TIMEOUT_CODE = 'timeout';

interface WithResponseResult {
  data: { data?: unknown[]; usage?: ImageUsage };
  response: { headers?: { get?: (name: string) => string | null } };
  request_id?: string | null;
}

type SdkImageCall = (
  request: unknown,
  options: unknown,
) => { withResponse(): Promise<WithResponseResult> };

/** Corpo da resposta do SDK mais o que a cena precisa: custo e id da requisição. */
export interface SceneCallResponse {
  data: Array<{ b64_json?: string; url?: string }>;
  usage?: ImageUsage;
  costUsd: number | null;
  requestId: string | null;
}

/** Recusa antes de qualquer rede: tamanho ou qualidade fora da tabela do modelo. */
export function assertSceneRequestAllowed(model: string, size: string, quality: string): void {
  const problem = validateImageSize(model, size) ?? validateImageQuality(model, quality);
  if (problem) throw new TerminalProviderError(problem, SCENE_INVALID_REQUEST_CODE);
}

/** Uma requisição ao SDK com timeout próprio, sem retry do SDK, lendo `usage` e `requestId`. */
export async function callSdkWithResponse(
  call: SdkImageCall,
  request: unknown,
  model: string,
  scene: SceneCallOptions,
): Promise<SceneCallResponse> {
  let result: WithResponseResult;
  try {
    result = await call(request, {
      ...OPENAI_NO_SDK_RETRY,
      timeout: scene.timeoutMs,
    }).withResponse();
  } catch (err) {
    if (err instanceof APIConnectionTimeoutError) {
      throw new TerminalProviderError(
        `Tempo esgotado após ${scene.timeoutMs} ms`,
        SCENE_TIMEOUT_CODE,
      );
    }
    // Conexão que caiu depois do envio pode ter sido processada (e cobrada): não se repete. Falha
    // antes de a requisição chegar ao servidor (DNS, recusada) continua elegível a retentativa.
    if (err instanceof APIConnectionError && !isPreRequestNetworkError(err)) {
      throw new TerminalProviderError(
        `Conexão perdida depois do envio: ${err.message}`,
        SCENE_CONNECTION_LOST_CODE,
      );
    }
    throw err;
  }
  const usage = result.data.usage;
  return {
    data: (result.data.data ?? []) as SceneCallResponse['data'],
    usage,
    costUsd: estimateCostUsd(model, usage),
    requestId: result.request_id ?? result.response.headers?.get?.('x-request-id') ?? null,
  };
}
