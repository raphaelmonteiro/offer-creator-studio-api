import { APIConnectionError, APIConnectionTimeoutError } from 'openai';
import {
  isPreRequestNetworkError,
  TerminalProviderError,
} from '../../shared/providers/provider-errors';
import { OPENAI_NO_SDK_RETRY } from '../../shared/providers/openai-errors';
import {
  estimateCostUsd,
  hasConfirmedPrice,
  ImageUsage,
  validateImageBackground,
  validateImageMarkup,
  validateImageMask,
  validateImageQuality,
  validateImageSize,
} from '../../shared/image/openai-image-capabilities';
import {
  SCENE_CONNECTION_LOST_CODE,
  SCENE_INVALID_REQUEST_CODE,
  SCENE_TIMEOUT_CODE,
} from '../../shared/providers/openai-scene-call-errors';

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

interface WithResponseResult {
  data: { data?: unknown[]; usage?: ImageUsage };
  response: { headers?: { get?: (name: string) => string | null } };
  request_id?: string | null;
}

export type SdkImageCall = (
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

/** O que a chamada da cena pede além de tamanho e qualidade, para a tabela de capacidades conferir. */
export interface SceneRequestExtras {
  /** `transparent` exige modelo que a tabela marcou como compatível. */
  background?: string;
  /** Edição com máscara por JSON (`images` + `mask`). */
  mask?: boolean;
  /** Edição com `markup` (multipart). */
  markup?: boolean;
}

/**
 * Recusa antes de qualquer rede: modelo pago sem preço conferido (G7: custo nunca vira zero), tamanho,
 * qualidade, fundo, máscara ou `markup` fora da tabela do modelo.
 */
export function assertSceneRequestAllowed(
  model: string,
  size: string,
  quality: string,
  extras: SceneRequestExtras = {},
): void {
  const problem =
    (hasConfirmedPrice(model)
      ? null
      : `${model} não tem preço conferido na tabela de capacidades`) ??
    validateImageSize(model, size) ??
    validateImageQuality(model, quality) ??
    (extras.background ? validateImageBackground(model, extras.background) : null) ??
    (extras.mask ? validateImageMask(model) : null) ??
    (extras.markup ? validateImageMarkup(model) : null);
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
