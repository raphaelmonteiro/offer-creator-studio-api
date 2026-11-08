/**
 * Preço dos modelos de texto e visão (`gpt-6-luna`), por 1 milhão de tokens em USD. Fonte:
 * https://developers.openai.com/api/docs/models/gpt-6-luna, consultada em 2026-11-06 (entrada US$ 0,10,
 * entrada em cache US$ 0,01, escrita em cache US$ 0,125, saída US$ 0,50; entrada acima de 272 mil tokens
 * custa o dobro, o que uma mensagem da cena nunca atinge). Modelo sem entrada aqui: custo `null`, e a
 * cena não o chama (G7: custo desconhecido nunca vira zero).
 */
export interface LlmPrices {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

const LLM_PRICES: Record<string, LlmPrices> = {
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
};

/** `usage` das duas APIs: `/responses` (`input_tokens`) e `chat.completions` (`prompt_tokens`). */
export interface LlmUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

const MILLION = 1_000_000;

export function llmPricesFor(model: string): LlmPrices | null {
  return LLM_PRICES[model] ?? null;
}

/**
 * Custo em USD: o que não veio de cache paga a entrada cheia, o lido do cache paga a taxa de cache e a escrita
 * em cache paga a taxa de escrita. `null` sem `usage`, sem contagem de entrada ou sem preço conferido.
 */
export function llmCostUsd(model: string, usage: LlmUsage | null | undefined): number | null {
  const price = llmPricesFor(model);
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  if (!price || !usage || input === undefined) return null;
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
  const cached = details?.cached_tokens ?? 0;
  const written = details?.cache_write_tokens ?? 0;
  const fresh = Math.max(0, input - cached - written);
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const cost =
    (fresh * price.input +
      cached * price.cachedInput +
      written * price.cacheWrite +
      output * price.output) /
    MILLION;
  return Math.round(cost * MILLION) / MILLION;
}
