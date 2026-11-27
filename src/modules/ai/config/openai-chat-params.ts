import OpenAI from 'openai';
import { OPENAI_NO_SDK_RETRY } from '../../../shared/providers/openai-errors';

/**
 * Parâmetros de uma chamada à OpenAI pela família do modelo (change 01-upgrade-openai-product-models, D-4 c,
 * D-6). `buildChatCompletionParams` monta a forma de `chat.completions`; `buildResponsesParams` (change
 * 24-add-flyer-pro-structure-suggestion-api) monta a de `/responses` (`max_output_tokens`, `reasoning.effort`),
 * reaproveitando `isGpt6Family` e `ModelCallSpec`, sem mudar quem já usa a primeira.
 *
 * - Família `gpt-6*`: `max_completion_tokens` (o raciocínio conta no teto), `reasoning_effort` explícito,
 *   `temperature` só com esforço `none`, nunca `max_tokens`.
 * - Qualquer outro nome: o corpo de hoje (`max_tokens` e `temperature`), sem `reasoning_effort` nem
 *   `max_completion_tokens`. Voltar ao modelo antigo pela variável restaura a chamada de hoje. O ponto que hoje não
 *   envia teto ou temperatura (change 42, `ChatCallSpec` sem `legacyMaxTokens` ou sem `temperature`) continua sem eles.
 * - Opções de requisição: o prazo da feature e `maxRetries: 0` (o SDK não repete sozinho), em qualquer família.
 * - `/responses`: família `gpt-6*` com `max_output_tokens` (o raciocínio conta no teto) e `reasoning: { effort }`, e
 *   `temperature` só com esforço `none`; outro nome com `max_output_tokens` e `temperature`, sem `reasoning`.
 */
export type ProductReasoningEffort = 'none' | 'low' | 'medium';

/** O que vale para qualquer API: modelo, esforço, temperatura e prazo. */
export interface ModelCallSpec {
  model: string;
  /** Esforço na família `gpt-6`; a família de hoje ignora. */
  effort: ProductReasoningEffort;
  /** Família de hoje: sempre. Família `gpt-6`: só com esforço `none`. */
  temperature: number;
  timeoutMs: number;
}

export interface ChatCallSpec extends Omit<ModelCallSpec, 'temperature'> {
  /**
   * Temperatura de hoje do ponto. Ausente quando o ponto não a envia hoje (change 42: configuração do template,
   * leitura de referência em camadas, descrição e traduções do kit): nenhuma família a leva.
   */
  temperature?: number;
  /**
   * Teto de saída de hoje (`max_tokens`, família de hoje). Ausente quando o ponto não tem teto hoje (change 42:
   * layout social, diretor, derivação de cena): a família de hoje sai sem `max_tokens`.
   */
  legacyMaxTokens?: number;
  /** Teto de saída da família `gpt-6` (`max_completion_tokens`), com folga para o raciocínio. Sempre vai. */
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
  return { body: isGpt6Family(spec.model) ? gpt6ChatBody(spec) : legacyChatBody(spec), options };
}

/** O corpo de hoje: `max_tokens` e `temperature` só onde o ponto os envia hoje. */
function legacyChatBody(spec: ChatCallSpec): ChatCallParams['body'] {
  return {
    model: spec.model,
    ...(spec.legacyMaxTokens === undefined ? {} : { max_tokens: spec.legacyMaxTokens }),
    ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
  };
}

/** Família `gpt-6`: teto e esforço sempre; `temperature` só com esforço `none` e só se o ponto a tem. */
function gpt6ChatBody(spec: ChatCallSpec): ChatCallParams['body'] {
  const withTemperature = spec.effort === 'none' && spec.temperature !== undefined;
  return {
    model: spec.model,
    max_completion_tokens: spec.maxCompletionTokens,
    reasoning_effort: spec.effort,
    ...(withTemperature ? { temperature: spec.temperature } : {}),
  };
}

export interface ResponsesCallSpec extends ModelCallSpec {
  /** Teto de saída de `/responses` (`max_output_tokens`), com folga para o raciocínio na família `gpt-6`. */
  maxOutputTokens: number;
}

/** Os campos de modelo, teto, esforço e temperatura do corpo de `/responses`; o chamador junta `instructions`, `input` e o formato. */
export interface ResponsesBodyParams {
  model: string;
  max_output_tokens: number;
  reasoning?: { effort: ProductReasoningEffort };
  temperature?: number;
}

export interface ResponsesCallParams {
  body: ResponsesBodyParams;
  /** Segundo argumento do `create`: prazo da feature e sem repetição do SDK. */
  options: { timeout: number; maxRetries: 0 };
}

export function buildResponsesParams(spec: ResponsesCallSpec): ResponsesCallParams {
  const options = { ...OPENAI_NO_SDK_RETRY, timeout: spec.timeoutMs };
  if (!isGpt6Family(spec.model)) {
    return {
      body: {
        model: spec.model,
        max_output_tokens: spec.maxOutputTokens,
        temperature: spec.temperature,
      },
      options,
    };
  }
  return {
    body: {
      model: spec.model,
      max_output_tokens: spec.maxOutputTokens,
      reasoning: { effort: spec.effort },
      ...(spec.effort === 'none' ? { temperature: spec.temperature } : {}),
    },
    options,
  };
}
