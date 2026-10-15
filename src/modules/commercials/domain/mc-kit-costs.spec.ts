import {
  findModelPrice,
  geminiUsage,
  kitFailedCallCost,
  kitProviderCost,
  MC_MODEL_PRICE_DEFAULTS,
  mcModelPrices,
  openAiUsage,
  parseModelPrices,
  priceUsage,
  sumKitCosts,
} from './mc-kit-costs';

describe('mc-kit-costs — tarifas e custo por chamada do kit (tarefa 2.6)', () => {
  describe('tabela padrão', () => {
    it('imagens pelo design.md: Nano Banana Pro US$ 0,134 e Nano Banana 2.1 US$ 0,034 por imagem', () => {
      const prices = mcModelPrices({});
      expect(findModelPrice('nano-banana-pro-preview', prices)?.usdPerImage).toBe(0.134);
      expect(findModelPrice('gemini-3-pro-image-preview', prices)?.usdPerImage).toBe(0.134);
      expect(findModelPrice('gemini-nano-banana-2.1', prices)?.usdPerImage).toBe(0.034);
    });

    it('texto por token: gpt-4o 2,5/10 e gpt-4o-mini 0,15/0,6 por 1M (mesma tabela do repositório)', () => {
      const prices = mcModelPrices({});
      expect(findModelPrice('gpt-4o', prices)).toMatchObject({
        inputUsdPer1M: 2.5,
        outputUsdPer1M: 10,
        usdPerImage: 0,
      });
      expect(findModelPrice('gpt-4o-mini', prices)).toMatchObject({
        inputUsdPer1M: 0.15,
        outputUsdPer1M: 0.6,
      });
    });

    it('snapshot datado da OpenAI casa pelo MAIOR prefixo; modelo desconhecido → null', () => {
      const prices = mcModelPrices({});
      expect(findModelPrice('gpt-4o-2024-08-06', prices)?.model).toBe('gpt-4o');
      expect(findModelPrice('gpt-4o-mini-2024-07-18', prices)?.model).toBe('gpt-4o-mini');
      expect(findModelPrice('gpt-4omni', prices)).toBeNull(); // prefixo só com hífen
      expect(findModelPrice('modelo-novo', prices)).toBeNull();
      expect(findModelPrice('', prices)).toBeNull();
      expect(findModelPrice(null, prices)).toBeNull();
    });
  });

  describe('MC_KIT_PRICES (modelo|usdPorImagem|usdPor1MEntrada|usdPor1MSaida)', () => {
    it('vazio = tabela padrão', () => {
      expect(parseModelPrices(undefined)).toEqual(MC_MODEL_PRICE_DEFAULTS);
      expect(parseModelPrices('  ')).toEqual(MC_MODEL_PRICE_DEFAULTS);
    });

    it('substitui a tarifa do mesmo modelo; campo vazio herda o padrão; modelo novo com os três números', () => {
      const prices = parseModelPrices(
        'gemini-nano-banana-2.1|0.039, gpt-4o||| , gemini-9-flash|0|0.1|0.4',
      );
      expect(findModelPrice('gemini-nano-banana-2.1', prices)).toEqual({
        model: 'gemini-nano-banana-2.1',
        usdPerImage: 0.039,
        inputUsdPer1M: 2,
        outputUsdPer1M: 12,
      });
      expect(findModelPrice('gpt-4o', prices)).toMatchObject({ inputUsdPer1M: 2.5 });
      expect(findModelPrice('gemini-9-flash', prices)).toEqual({
        model: 'gemini-9-flash',
        usdPerImage: 0,
        inputUsdPer1M: 0.1,
        outputUsdPer1M: 0.4,
      });
      expect(prices).toHaveLength(MC_MODEL_PRICE_DEFAULTS.length + 1);
    });

    it('mal formado é erro de configuração (nunca tarifa silenciosa)', () => {
      expect(() => parseModelPrices('|0.1|1|1')).toThrow(/modelo em branco/);
      expect(() => parseModelPrices('gpt-4o|-1')).toThrow(/tarifa inválida/);
      expect(() => parseModelPrices('gpt-4o|abc')).toThrow(/tarifa inválida/);
      expect(() => parseModelPrices('modelo-novo|0.1')).toThrow(/não está na tabela padrão/);
      expect(() => parseModelPrices('gpt-4o|0|1|1|9')).toThrow(/campos demais/);
    });

    it('mcModelPrices lê do env a cada chamada', () => {
      const prices = mcModelPrices({ MC_KIT_PRICES: 'nano-banana-pro-preview|0.2' });
      expect(findModelPrice('nano-banana-pro-preview', prices)?.usdPerImage).toBe(0.2);
    });
  });

  describe('uso cobrável por fornecedor', () => {
    it('OpenAI: prompt_tokens → entrada, completion_tokens → saída; sem usage → null', () => {
      expect(openAiUsage({ prompt_tokens: 1200, completion_tokens: 500 })).toEqual({
        inputTokens: 1200,
        outputTokens: 500,
        images: 0,
      });
      expect(openAiUsage(undefined)).toBeNull();
      expect(openAiUsage({ prompt_tokens: null, completion_tokens: -3 })).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        images: 0,
      });
    });

    it('Gemini, geração: a saída IMAGE sai pelo preço por imagem; texto + raciocínio como saída', () => {
      expect(
        geminiUsage(
          {
            promptTokens: 1500,
            candidatesTokens: 1140,
            thoughtsTokens: 200,
            outputImageTokens: 1120,
            totalTokens: 2840,
          },
          1,
        ),
      ).toEqual({ inputTokens: 1500, outputTokens: 220, images: 1 });
      // sem detalhe por modalidade: a saída de uma geração é tratada como imagem
      expect(
        geminiUsage(
          {
            promptTokens: 10,
            candidatesTokens: 1120,
            thoughtsTokens: 5,
            outputImageTokens: null,
            totalTokens: null,
          },
          1,
        ),
      ).toEqual({ inputTokens: 10, outputTokens: 5, images: 1 });
      // sem usageMetadata: ainda cobra a imagem
      expect(geminiUsage(null, 1)).toEqual({ inputTokens: 0, outputTokens: 0, images: 1 });
    });

    it('Gemini, visão: toda a saída é texto; sem uso → desconhecido (null)', () => {
      expect(
        geminiUsage(
          {
            promptTokens: 1200,
            candidatesTokens: 80,
            thoughtsTokens: 220,
            outputImageTokens: null,
            totalTokens: 1500,
          },
          0,
        ),
      ).toEqual({ inputTokens: 1200, outputTokens: 300, images: 0 });
      expect(geminiUsage(undefined, 0)).toBeNull();
    });
  });

  describe('custo por chamada', () => {
    it('imagens × preço + entrada/1M + saída/1M, 6 casas', () => {
      expect(
        priceUsage(
          { inputTokens: 1000, outputTokens: 0, images: 1 },
          { model: 'm', usdPerImage: 0.034, inputUsdPer1M: 2, outputUsdPer1M: 12 },
        ),
      ).toBe(0.036);
      expect(
        priceUsage(
          { inputTokens: 1200, outputTokens: 500, images: 0 },
          { model: 'gpt-4o', usdPerImage: 0, inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
        ),
      ).toBe(0.008);
    });

    it('linha de custo leva a tarifa aplicada; modelo fora da tabela ou uso desconhecido → costUsd null', () => {
      const ok = kitProviderCost(
        {
          call: 'reference',
          provider: 'gemini',
          model: 'gemini-nano-banana-2.1',
          usage: { inputTokens: 1000, outputTokens: 0, images: 1 },
        },
        {},
      );
      expect(ok).toMatchObject({
        call: 'reference',
        costUsd: 0.036,
        rate: { model: 'gemini-nano-banana-2.1', usdPerImage: 0.034 },
      });
      expect(
        kitProviderCost(
          { call: 'reference', provider: 'gemini', model: 'desconhecido', usage: ok.usage },
          {},
        ),
      ).toMatchObject({ costUsd: null, rate: null });
      expect(
        kitProviderCost(
          { call: 'canonical_desc', provider: 'openai', model: 'gpt-4o', usage: null },
          {},
        ).costUsd,
      ).toBeNull();
    });

    it('kit típico da 2.6 (descrição gpt-4o + 4 referências na 2.1) fica abaixo de US$ 0,30', () => {
      const desc = kitProviderCost(
        {
          call: 'canonical_desc',
          provider: 'openai',
          model: 'gpt-4o-2024-08-06',
          usage: { inputTokens: 1200, outputTokens: 600, images: 0 },
        },
        {},
      );
      const refs = [0, 1, 2, 3].map(() =>
        kitProviderCost(
          {
            call: 'reference',
            provider: 'gemini',
            model: 'gemini-nano-banana-2.1',
            usage: { inputTokens: 1500, outputTokens: 200, images: 1 },
          },
          {},
        ),
      );
      const gate = kitProviderCost(
        {
          call: 'mouth_gate',
          provider: 'gemini',
          model: 'gemini-3.8-flash',
          usage: { inputTokens: 1300, outputTokens: 400, images: 0 },
        },
        {},
      );
      const total = sumKitCosts([desc, ...refs, gate]);
      expect(total).toBeGreaterThan(0.136); // 4 × 0,034 é o piso
      expect(total).toBeLessThan(0.3);
      expect(sumKitCosts([{ costUsd: 0.1 }, { costUsd: null }, { costUsd: 0.05 }])).toBe(0.15);
    });
  });

  describe('chamada cobrada sem resultado (kitFailedCallCost)', () => {
    it('resposta sem imagem: pelo uso devolvido, sem preço de imagem; timeout: estimativa pelo preço das imagens pedidas', () => {
      const noOutput = kitFailedCallCost(
        {
          call: 'reference',
          billing: {
            model: 'nano-banana-pro-preview',
            usage: {
              promptTokens: 1000,
              candidatesTokens: 0,
              thoughtsTokens: 500,
              outputImageTokens: null,
              totalTokens: 1500,
            },
          },
          expectedImages: 1,
        },
        {},
      );
      expect(noOutput).toMatchObject({
        call: 'reference',
        provider: 'gemini',
        failure: 'no_output',
        usage: { inputTokens: 1000, outputTokens: 500, images: 0 },
      });
      expect(noOutput.estimated).toBeUndefined();
      expect(noOutput.costUsd).toBeCloseTo(0.008, 6); // 1000 × 2/1M + 500 × 12/1M

      const timedOut = kitFailedCallCost(
        {
          call: 'candidate',
          billing: { model: 'gemini-nano-banana-2.1', usage: null, timedOut: true },
          expectedImages: 1,
        },
        {},
      );
      expect(timedOut).toMatchObject({
        failure: 'timed_out',
        estimated: true,
        costUsd: 0.034,
        usage: { inputTokens: 0, outputTokens: 0, images: 1 },
      });

      // sem usageMetadata numa resposta sem imagem: custo desconhecido (fora da soma)
      expect(
        kitFailedCallCost(
          {
            call: 'mouth_gate',
            billing: { model: 'gemini-3.8-flash', usage: null },
            expectedImages: 0,
          },
          {},
        ).costUsd,
      ).toBeNull();
    });
  });
});
