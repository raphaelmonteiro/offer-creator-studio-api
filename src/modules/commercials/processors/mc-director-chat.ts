import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { callProductChat } from '../../ai/utils/ai-product-chat.util';
import { withOpenAiRetry } from '../../../shared/providers/openai-errors';
import { MC_DIRECTOR_CALL, MC_DIRECTOR_TOTAL_MS } from '../domain/mc-text-calls';

/** Menos que isto de prazo restante não paga outra tentativa: a chamada só estouraria o prazo e esconderia o erro do provedor. */
const DIRECTOR_MIN_ATTEMPT_MS = 10_000;

/** Consumidor do diretor no log (`AI operation started|finished|failed`). */
export const MC_DIRECTOR_FEATURE = 'commercials.director';

export interface DirectorChatRequest {
  openai: OpenAI;
  logger: Logger;
  model: string;
  /** `json_schema` estrito do formato (cenas v1 e v2, arte que fala, ofertas em sequência ou peça de ofertas). */
  schema: Record<string, unknown>;
  system: string;
  user: string;
}

/**
 * Chamada do diretor, a mesma nos quatro formatos (change 42, A-3): cliente do SDK sem repetição própria, prazo e
 * parâmetros pela família do modelo (`callProductChat`), e `withOpenAiRetry` como a única camada de repetição, que
 * repete só 429 de taxa e 5xx (conta sem crédito, rede e prazo estourado param na primeira resposta). O prazo de 100 s
 * (`MC_DIRECTOR_TOTAL_MS`) é do conjunto de tentativas e esperas, abaixo da expiração de 120 s do job: cada tentativa leva
 * só o que resta, e uma espera que não deixa uma tentativa útil encerra com o erro do provedor (R2). Devolve o JSON do roteiro já lido; cada
 * formato monta o seu `McScript`. As mensagens de falha são as de sempre (`script_failed: ...`).
 */
export async function requestDirectorJson<T>(request: DirectorChatRequest): Promise<T> {
  const response = await sendWithRetry(request);
  const choice = response.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('script_failed: resposta do OpenAI sem conteúdo');
  if (choice?.finish_reason === 'length') {
    throw new Error('script_failed: resposta do OpenAI cortada pelo teto de saída');
  }
  return JSON.parse(content) as T;
}

async function sendWithRetry(request: DirectorChatRequest): Promise<OpenAI.Chat.ChatCompletion> {
  let providerError: unknown;
  let startedAt: number | undefined;
  const remainingMs = (now = Date.now()) => MC_DIRECTOR_TOTAL_MS - (now - (startedAt ?? now));
  try {
    return await withOpenAiRetry(
      async () => {
        const now = Date.now();
        startedAt ??= now;
        try {
          return await callDirector(request, remainingMs(now));
        } catch (err) {
          providerError = err;
          throw err;
        }
      },
      {
        retryConnectionErrors: false,
        onRetry: (err, _nextAttempt, delayMs) => {
          if (remainingMs() - delayMs < DIRECTOR_MIN_ATTEMPT_MS) throw err;
        },
      },
    );
  } catch (err) {
    throw new Error(directorFailureMessage(providerError ?? err));
  }
}

function callDirector(
  request: DirectorChatRequest,
  timeoutMs: number,
): Promise<OpenAI.Chat.ChatCompletion> {
  return callProductChat({
    openai: request.openai,
    logger: request.logger,
    feature: MC_DIRECTOR_FEATURE,
    spec: { model: request.model, ...MC_DIRECTOR_CALL, timeoutMs },
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    responseFormat: {
      type: 'json_schema',
      json_schema: request.schema as unknown as OpenAI.ResponseFormatJSONSchema['json_schema'],
    },
  });
}

/** `script_failed: OpenAI HTTP <status>: <mensagem do provedor>` como antes; sem status (rede, prazo), a mensagem do erro. */
function directorFailureMessage(err: unknown): string {
  const failure = err as {
    status?: unknown;
    message?: string;
    error?: { message?: string };
  } | null;
  if (typeof failure?.status === 'number') {
    return `script_failed: OpenAI HTTP ${failure.status}: ${failure.error?.message ?? failure.message ?? ''}`;
  }
  return `script_failed: ${failure?.message ?? 'erro desconhecido'}`;
}
