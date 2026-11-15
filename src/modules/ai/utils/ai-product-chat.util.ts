import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { buildChatCompletionParams, ChatCallSpec } from '../config/openai-chat-params';
import { withAiLogging } from './ai-telemetry.util';

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
}

export async function callProductChat(call: ProductChatCall): Promise<OpenAI.Chat.ChatCompletion> {
  const { body, options } = buildChatCompletionParams(call.spec);
  const request: ChatBody = {
    ...body,
    messages: call.messages,
    ...(call.responseFormat ? { response_format: call.responseFormat } : {}),
  };
  const response = await withAiLogging(
    call.logger,
    {
      feature: call.feature,
      endpoint: 'chat.completions',
      model: call.spec.model,
      ...(call.mode ? { mode: call.mode } : {}),
    },
    () => call.openai.chat.completions.create(request, options),
  );
  warnIfEmptyOrTruncated(call, response);
  return response;
}

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
    })}`,
  );
}
