import { llmPricesFor } from '../../ai/openai-llm-pricing';
import {
  findModelPrice,
  kitProviderCost,
  MC_MODEL_PRICE_DEFAULTS,
  mcModelPrices,
  parseModelPrices,
} from './mc-kit-costs';

describe('mc-kit-costs com os modelos novos da OpenAI (change 42, task 1.4)', () => {
  it('Tabela do kit com os modelos novos: Luna e Terra com os mesmos valores do log das cinco features, além das de hoje', () => {
    const prices = parseModelPrices('');
    expect(findModelPrice('gpt-6-luna', prices)).toEqual({
      model: 'gpt-6-luna',
      usdPerImage: 0,
      inputUsdPer1M: 0.1,
      outputUsdPer1M: 0.5,
    });
    expect(findModelPrice('gpt-6.1-terra', prices)).toEqual({
      model: 'gpt-6.1-terra',
      usdPerImage: 0,
      inputUsdPer1M: 1,
      outputUsdPer1M: 5,
    });
    expect(findModelPrice('gpt-4o', prices)).toMatchObject({
      inputUsdPer1M: 2.5,
      outputUsdPer1M: 10,
    });
    expect(findModelPrice('gpt-4o-mini', prices)).toMatchObject({
      inputUsdPer1M: 0.15,
      outputUsdPer1M: 0.6,
    });
  });

  it('as entradas da OpenAI da tabela padrão saem do lugar único do preço', () => {
    for (const model of ['gpt-6-luna', 'gpt-6.1-terra']) {
      const price = llmPricesFor(model);
      expect(findModelPrice(model, MC_MODEL_PRICE_DEFAULTS)).toMatchObject({
        inputUsdPer1M: price.input,
        outputUsdPer1M: price.output,
      });
    }
  });

  it('Entrada do kit substitui o padrão: MC_KIT_PRICES=gpt-6-luna|0|0.2|1 custa US$ 0,0007 com 1.000 e 500', () => {
    const env = { MC_KIT_PRICES: 'gpt-6-luna|0|0.2|1' };
    const line = kitProviderCost(
      {
        call: 'sheet_translation',
        provider: 'openai',
        model: 'gpt-6-luna',
        usage: { inputTokens: 1000, outputTokens: 500, images: 0 },
      },
      env,
    );
    expect(line.costUsd).toBe(0.0007);
    expect(mcModelPrices(env).filter((p) => p.model === 'gpt-6-luna')).toHaveLength(1);
  });

  it('Descrição canônica em Terra: o snapshot datado casa pelo prefixo e a linha custa US$ 0,0045', () => {
    const line = kitProviderCost(
      {
        call: 'canonical_desc',
        provider: 'openai',
        model: 'gpt-6.1-terra-2026-10-01',
        usage: { inputTokens: 1500, outputTokens: 600, images: 0 },
      },
      {},
    );
    expect(line).toMatchObject({
      call: 'canonical_desc',
      model: 'gpt-6.1-terra-2026-10-01',
      costUsd: 0.0045,
    });
    expect(line.rate?.model).toBe('gpt-6.1-terra');
  });

  it('Modelo fora da tabela: a linha guarda os tokens e o custo é nulo, nunca zero', () => {
    const usage = { inputTokens: 1500, outputTokens: 600, images: 0 };
    const line = kitProviderCost(
      { call: 'canonical_desc', provider: 'openai', model: 'gpt-5-mini', usage },
      {},
    );
    expect(line.usage).toEqual(usage);
    expect(line.costUsd).toBeNull();
    expect(line.rate).toBeNull();
  });
});
