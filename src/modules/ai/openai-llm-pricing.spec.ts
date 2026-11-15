import { costFromPrices, llmCostUsd, llmPricesFor } from './openai-llm-pricing';

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

describe('llmCostUsd, gpt-6.1-terra (F-26, consulta de 2026-11-15)', () => {
  it('tem os quatro preços da página: US$ 1,00, 0,05, 1,25 e 5,00 por milhão', () => {
    expect(llmPricesFor('gpt-6.1-terra')).toEqual({
      input: 1,
      cachedInput: 0.05,
      cacheWrite: 1.25,
      output: 5,
    });
  });

  it('2.000 de entrada sem cache e 300 de saída = US$ 0,0035', () => {
    expect(llmCostUsd('gpt-6.1-terra', { prompt_tokens: 2000, completion_tokens: 300 })).toBe(
      0.0035,
    );
  });

  it('entrada lida do cache paga US$ 0,05, e a escrita em cache US$ 1,25', () => {
    expect(
      llmCostUsd('gpt-6.1-terra', {
        input_tokens: 10_000,
        input_tokens_details: { cached_tokens: 10_000 },
        output_tokens: 0,
      }),
    ).toBe(0.0005);
    expect(
      llmCostUsd('gpt-6.1-terra', {
        input_tokens: 10_000,
        input_tokens_details: { cache_write_tokens: 10_000 },
        output_tokens: 0,
      }),
    ).toBe(0.0125);
  });

  it('Luna com 1.000 de entrada e 200 de saída = US$ 0,0002', () => {
    expect(llmCostUsd('gpt-6-luna', { prompt_tokens: 1000, completion_tokens: 200 })).toBe(0.0002);
  });

  it('modelos de hoje (gpt-4o, gpt-4o-mini) continuam fora da tabela: custo nulo', () => {
    const usage = { prompt_tokens: 1000, completion_tokens: 200 };
    expect(llmCostUsd('gpt-4o', usage)).toBeNull();
    expect(llmCostUsd('gpt-4o-mini', usage)).toBeNull();
    expect(llmPricesFor('gpt-4o')).toBeNull();
  });

  it('modelo desconhecido e ausência de usage dão nulo', () => {
    expect(llmCostUsd('gpt-6-lua', { prompt_tokens: 10, completion_tokens: 10 })).toBeNull();
    expect(llmCostUsd('gpt-6.1-terra', undefined)).toBeNull();
    expect(llmCostUsd('gpt-6.1-terra', null)).toBeNull();
  });
});

describe('costFromPrices, preço de cache que a página não informa (D-11)', () => {
  const onlyInputOutput = { input: 2, output: 10 };

  it('a entrada lida do cache e a escrita em cache pagam a entrada cheia', () => {
    const usage = {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 400_000, cache_write_tokens: 100_000 },
      output_tokens: 0,
    };
    expect(costFromPrices(onlyInputOutput, usage)).toBe(2);
  });

  it('com os preços de cache informados, o cache sai mais barato que a entrada cheia', () => {
    const usage = {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 400_000 },
      output_tokens: 0,
    };
    expect(costFromPrices({ ...onlyInputOutput, cachedInput: 0.2 }, usage)).toBeLessThan(2);
  });
});
