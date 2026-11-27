import { ChatCallSpec } from './openai-chat-params';

/**
 * Tetos de saída das cinco features de IA de produto (D-7, PV-1 do `design.md`).
 *
 * `legacy` é o de hoje (família `gpt-4o`, `max_tokens`). `gpt6` é o da família nova
 * (`max_completion_tokens`): maior, porque o raciocínio é cobrado como saída e conta no teto, e um teto
 * apertado devolve texto vazio ou JSON cortado.
 */
export type OutputCeiling = Required<Pick<ChatCallSpec, 'legacyMaxTokens' | 'maxCompletionTokens'>>;

/** Ortografia: 10 campos por lote, esforço `low`. */
export const SPELLCHECK_CEILING: OutputCeiling = {
  legacyMaxTokens: 2048,
  maxCompletionTokens: 8192,
};

/** Leitura do nome: 8 nomes por lote (cerca de 250 a 400 tokens de saída cada), esforço `low`. */
export const NAME_PARSER_CEILING: OutputCeiling = {
  legacyMaxTokens: 8000,
  maxCompletionTokens: 16_000,
};

/** Leitura da foto: 1 imagem, JSON de cerca de 600 tokens, esforço `low`. */
export const GALLERY_VISION_CEILING: OutputCeiling = {
  legacyMaxTokens: 900,
  maxCompletionTokens: 4096,
};

/** Tradução de 1 termo, esforço `none`: sem raciocínio, mas com margem para a resposta nunca esvaziar. */
export const TRANSLATION_CEILING: OutputCeiling = {
  legacyMaxTokens: 32,
  maxCompletionTokens: 128,
};

/** Categorização: de hoje `min(4096, 300 + 90n)`; na família nova `min(16384, 1000 + 150n)` (sempre maior). */
export function categorizationCeiling(items: number): OutputCeiling {
  return {
    legacyMaxTokens: Math.min(4096, 300 + items * 90),
    maxCompletionTokens: Math.min(16_384, 1000 + items * 150),
  };
}
