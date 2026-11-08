import { llmCostUsd, llmPricesFor } from './openai-llm-pricing';

describe('llmCostUsd', () => {
  it('chamada sem cache do ledger da Etapa 0: 602 de entrada e 272 de saída = US$ 0,000196', () => {
    const usage = {
      input_tokens: 602,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens: 272,
    };
    expect(llmCostUsd('gpt-6-luna', usage)).toBe(0.000196);
  });

  it('entrada lida do cache paga a taxa de cache: 2.653 com 2.650 em cache e 340 de saída = US$ 0,000197', () => {
    const usage = {
      input_tokens: 2653,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 2650 },
      output_tokens: 340,
    };
    expect(llmCostUsd('gpt-6-luna', usage)).toBe(0.000197);
  });

  it('escrita em cache paga US$ 0,125 por milhão', () => {
    const usage = {
      input_tokens: 10_000,
      input_tokens_details: { cache_write_tokens: 10_000, cached_tokens: 0 },
      output_tokens: 0,
    };
    expect(llmCostUsd('gpt-6-luna', usage)).toBe(0.00125);
  });

  it('o formato do chat.completions (prompt_tokens) dá o mesmo custo, e serve ao juiz', () => {
    const responses = { input_tokens: 2000, output_tokens: 100 };
    const chat = { prompt_tokens: 2000, completion_tokens: 100 };
    expect(llmCostUsd('gpt-6-luna', chat)).toBe(llmCostUsd('gpt-6-luna', responses));
    expect(llmCostUsd('gpt-6-luna', chat)).toBe(0.00025);
  });

  it('null sem usage, sem contagem de entrada e para modelo sem preço', () => {
    expect(llmCostUsd('gpt-6-luna', null)).toBeNull();
    expect(llmCostUsd('gpt-6-luna', {})).toBeNull();
    expect(llmCostUsd('gpt-6-astra', { input_tokens: 10, output_tokens: 10 })).toBeNull();
    expect(llmPricesFor('gpt-6-astra')).toBeNull();
  });
});
