import { Logger } from '@nestjs/common';
import OpenAI, { APIConnectionTimeoutError } from 'openai';
import { buildChatCompletionParams, ChatCallSpec } from '../config/openai-chat-params';
import { withAiLogging } from './ai-telemetry.util';
import { AiUsageCollector } from './ai-usage';

type ChatBody = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

/**
 * Chamada a `chat.completions` das cinco features de IA de produto do encarte: parâmetros pela família do
 * modelo, prazo da feature e sem repetição do SDK (helper), log de início, fim e falha (`withAiLogging`) e
 * aviso de resposta vazia ou cortada pelo teto de saída (D-16). O chamador junta `messages` e o formato de saída.
 */
export interface ProductChatCall {
  openai: OpenAI;
  logger: Logger;
  feature: string;
  spec: ChatCallSpec;
  messages: ChatBody['messages'];
  responseFormat?: ChatBody['response_format'];
  /** Passada da leitura da foto (`low` ou `high`), registrada no log. */
  mode?: string;
  /** Liga as linhas de log de uma mesma leitura de foto (uma ou duas passadas). */
  correlationId?: string;
  /** Coletor do uso da invocação (D-12); a chamada que falha com resposta de erro não entra, a abortada no meio entra sem uso. */
  usage?: AiUsageCollector;
  /** Cancela a chamada em andamento (change 29); ausente, a chamada é a de hoje. */
  signal?: AbortSignal;
}

export async function callProductChat(call: ProductChatCall): Promise<OpenAI.Chat.ChatCompletion> {
  const { body, options } = buildChatCompletionParams(call.spec);
  const request: ChatBody = {
    ...body,
    messages: call.messages,
    ...(call.responseFormat ? { response_format: call.responseFormat } : {}),
  };
  const run = () =>
    withAiLogging(
      call.logger,
      {
        feature: call.feature,
        endpoint: 'chat.completions',
        model: call.spec.model,
        ...(call.mode ? { mode: call.mode } : {}),
        ...(call.correlationId ? { correlationId: call.correlationId } : {}),
        pricing: 'table',
      },
      () =>
        call.openai.chat.completions.create(
          request,
          call.signal ? { ...options, signal: call.signal } : options,
        ),
    );
  const response = call.usage
    ? await call.usage.track(call.spec.model, run, (error) => wasAborted(call, error))
    : await run();
  warnIfEmptyOrTruncated(call, response);
  return response;
}

/** A chamada foi abortada no meio: pelo sinal do chamador (prazo do lote) ou pelo prazo da própria chamada. */
const wasAborted = (call: ProductChatCall, error: unknown): boolean =>
  !!call.signal?.aborted || error instanceof APIConnectionTimeoutError;

/** Linha de aviso (feature, modelo, motivo) quando a resposta veio vazia ou cortada pelo teto de saída. */
function warnIfEmptyOrTruncated(call: ProductChatCall, response: OpenAI.Chat.ChatCompletion): void {
  const choice = response.choices?.[0];
  const reason =
    choice?.finish_reason === 'length'
      ? 'truncated'
      : !choice?.message?.content?.trim()
        ? 'empty'
        : null;
  if (!reason) return;
  call.logger.warn(
    `AI response invalid ${JSON.stringify({
      feature: call.feature,
      model: call.spec.model,
      reason,
      ...(call.mode ? { mode: call.mode } : {}),
      ...(call.correlationId ? { correlationId: call.correlationId } : {}),
    })}`,
  );
}
