import { callProductChat, ProductChatCall } from './ai-product-chat.util';

/**
 * Saída estrita (`json_schema`) com nova tentativa quando a resposta vem vazia ou fora do schema (D-14,
 * `OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS`): cada tentativa é uma chamada com o seu prazo.
 */
export interface StructuredChatCall<T> extends ProductChatCall {
  parse: (raw: string) => T;
  emptyResponseMessage: string;
  /** Tentativas a mais depois da primeira. */
  retryAttempts: number;
}

export async function createStructuredChatCompletion<T>(call: StructuredChatCall<T>): Promise<T> {
  const maxAttempts = call.retryAttempts + 1;
  const messages = [...call.messages];
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await callProductChat({ ...call, messages });
    const raw = response.choices[0]?.message?.content;
    try {
      if (!raw) throw new Error(call.emptyResponseMessage);
      return call.parse(raw);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) throw error;

      const reason = retryReasonOf(error);
      call.logger.warn(
        `Structured response retry ${JSON.stringify({
          feature: call.feature,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          reason,
          model: call.spec.model,
        })}`,
      );
      messages.push({
        role: 'user',
        content:
          'The previous response was invalid for the expected JSON schema. ' +
          `Validation error: ${reason}. ` +
          'Return only valid JSON for the expected schema, without markdown or explanations.',
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Resposta estruturada inválida da IA');
}

function retryReasonOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 180);
  return 'structured-response-validation-failed';
}
