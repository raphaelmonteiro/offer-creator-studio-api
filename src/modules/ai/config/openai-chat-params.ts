import OpenAI from 'openai';
import { OPENAI_NO_SDK_RETRY } from '../../../shared/providers/openai-errors';

/**
 * Parâmetros de uma chamada a `chat.completions` pela família do modelo (change
 * 01-upgrade-openai-product-models, D-4 c, D-6). Só `chat.completions`: a forma de `/responses`
 * (`max_output_tokens`, `reasoning.effort`) entra neste mesmo arquivo pela change 24, como uma segunda
 * função que reaproveita `isGpt6Family` e `ModelCallSpec`, sem mudar quem já usa a de hoje.
 *
 * - Família `gpt-6*`: `max_completion_tokens` (o raciocínio conta no teto), `reasoning_effort` explícito,
 *   `temperature` só com esforço `none`, nunca `max_tokens`.
 * - Qualquer outro nome: o corpo de hoje (`max_tokens` e `temperature`), sem `reasoning_effort` nem
 *   `max_completion_tokens`. Voltar ao modelo antigo pela variável restaura a chamada de hoje.
 * - Opções de requisição: o prazo da feature e `maxRetries: 0` (o SDK não repete sozinho), em qualquer família.
 */
export type ProductReasoningEffort = 'none' | 'low';

/** O que vale para qualquer API: modelo, esforço, temperatura e prazo. */
export interface ModelCallSpec {
  model: string;
  /** Esforço na família `gpt-6`; a família de hoje ignora. */
  effort: ProductReasoningEffort;
  /** Família de hoje: sempre. Família `gpt-6`: só com esforço `none`. */
  temperature: number;
  timeoutMs: number;
}

export interface ChatCallSpec extends ModelCallSpec {
  /** Teto de saída de hoje (`max_tokens`, família de hoje). */
  legacyMaxTokens: number;
  /** Teto de saída da família `gpt-6` (`max_completion_tokens`), com folga para o raciocínio. */
  maxCompletionTokens: number;
}

type ChatBody = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

export interface ChatCallParams {
  /** Campos de modelo, teto, temperatura e esforço; o chamador junta `messages` e `response_format`. */
  body: Pick<
    ChatBody,
    'model' | 'max_tokens' | 'max_completion_tokens' | 'temperature' | 'reasoning_effort'
  >;
  /** Segundo argumento do `create`: prazo da feature e sem repetição do SDK. */
  options: { timeout: number; maxRetries: 0 };
}

/** Nome começando por `gpt-6` é a família nova; qualquer outro é a família de hoje (D-6). */
export function isGpt6Family(model: string): boolean {
  return model.startsWith('gpt-6');
}

export function buildChatCompletionParams(spec: ChatCallSpec): ChatCallParams {
  const options = { ...OPENAI_NO_SDK_RETRY, timeout: spec.timeoutMs };
  if (!isGpt6Family(spec.model)) {
    return {
      body: { model: spec.model, max_tokens: spec.legacyMaxTokens, temperature: spec.temperature },
      options,
    };
  }
  return {
    body: {
      model: spec.model,
      max_completion_tokens: spec.maxCompletionTokens,
      reasoning_effort: spec.effort,
      ...(spec.effort === 'none' ? { temperature: spec.temperature } : {}),
    },
    options,
  };
}
