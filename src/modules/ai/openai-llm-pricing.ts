/**
 * Preço dos modelos de texto e visão, por 1 milhão de tokens em USD. Entrada acima de 272 mil tokens custa o
 * dobro (e a saída 1,5 vez), o que nenhuma chamada daqui atinge. Modelo sem entrada aqui: custo `null`, e a
 * cena do Template Pro não o chama (G7: custo desconhecido nunca vira zero). `gpt-4o` e `gpt-4o-mini` não
 * entram de propósito: custo `null` no log, e continuam fora da trava do Template Pro (D-11).
 *
 * Fontes (https://developers.openai.com/api/docs/models/<modelo> e /api/docs/pricing):
 * - `gpt-6-luna`: entrada US$ 0,10, entrada em cache US$ 0,01, escrita em cache US$ 0,125, saída US$ 0,50;
 *   consultada em 2026-11-06 e reconferida em 2026-11-15.
 * - `gpt-6.1-terra`: entrada US$ 1,00, entrada em cache US$ 0,05, escrita em cache (30 minutos) US$ 1,25,
 *   saída US$ 5,00; consultada em 2026-11-15 (change 01-upgrade-openai-product-models, F-26). A escrita de
 *   12 horas (US$ 2,50) não é usada.
 *
 * Preço de cache que a página não informe vale a entrada cheia (D-11): a estimativa nunca fica abaixo do real.
 */
export interface LlmPrices {
  input: number;
  /** Entrada lida do cache; ausente, paga a entrada cheia. */
  cachedInput?: number;
  /** Escrita em cache; ausente, paga a entrada cheia. */
  cacheWrite?: number;
  output: number;
}

const LLM_PRICES: Record<string, LlmPrices> = {
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6.1-terra': { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 },
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
  return price ? costFromPrices(price, usage) : null;
}

/** Preço de cache que a página não informa vale a entrada cheia (D-11). */
function withCacheRates(price: LlmPrices): Required<LlmPrices> {
  return {
    ...price,
    cachedInput: price.cachedInput ?? price.input,
    cacheWrite: price.cacheWrite ?? price.input,
  };
}

/** O cálculo de `llmCostUsd` para um preço dado (separado para testar o preço de cache ausente). */
export function costFromPrices(
  price: LlmPrices,
  usage: LlmUsage | null | undefined,
): number | null {
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  if (!usage || input === undefined) return null;
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details;
  const cached = details?.cached_tokens ?? 0;
  const written = details?.cache_write_tokens ?? 0;
  const fresh = Math.max(0, input - cached - written);
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  const rate = withCacheRates(price);
  const cost =
    (fresh * rate.input +
      cached * rate.cachedInput +
      written * rate.cacheWrite +
      output * rate.output) /
    MILLION;
  return Math.round(cost * MILLION) / MILLION;
}
