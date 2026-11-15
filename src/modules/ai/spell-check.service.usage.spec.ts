import { ProductCategorizationService } from './product-categorization.service';
import { AiUsageCollector } from './utils/ai-usage';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from './utils/openai-chat.testutil';
import { build, products } from './spell-check.service.testutil';

describe('SpellCheckService, uso por invocação (U0.7)', () => {
  const usageOf = () =>
    chatResponse({
      content: '{"corrections":[]}',
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });

  it('78 produtos (8 lotes): o uso soma o modelo, os tokens e o custo das 8 chamadas', async () => {
    const { service, create } = build();
    create.mockImplementation(async () => usageOf());
    const usage = new AiUsageCollector();

    await service.spellCheck(products(78), { usage });

    expect(usage.snapshot()).toEqual({
      model: 'gpt-6-luna',
      models: ['gpt-6-luna'],
      calls: 8,
      inputTokens: 8000,
      outputTokens: 1600,
      costUsd: 0.0016,
    });
  });

  it('quem não pede o uso recebe o mesmo resultado', async () => {
    const { service, create } = build();
    create.mockImplementation(async () => usageOf());
    const withUsage = await service.spellCheck(products(12), { usage: new AiUsageCollector() });
    const without = await service.spellCheck(products(12));
    expect(without).toEqual(withUsage);
  });

  it('flag desligada: nenhuma chamada, zero tokens e custo 0, com o modelo da feature', async () => {
    const { service, create } = build({ AI_SPELLCHECK_ENABLED: 'false' });
    const usage = new AiUsageCollector();
    await expect(service.spellCheck(products(3), { usage })).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(usage.snapshot()).toMatchObject({
      model: 'gpt-6-luna',
      calls: 0,
      inputTokens: 0,
      costUsd: 0,
    });
  });

  it('a nova tentativa por resposta fora do schema entra na soma', async () => {
    const { service, create } = build();
    create
      .mockResolvedValueOnce(
        chatResponse({
          content: '{"corrections":1}',
          usage: { prompt_tokens: 500, completion_tokens: 50 },
        }),
      )
      .mockResolvedValueOnce(usageOf());
    const usage = new AiUsageCollector();
    await service.spellCheck(products(1), { usage });
    expect(usage.snapshot()).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 250 });
  });

  it('lote que falhou fica fora da soma', async () => {
    const { service, create } = build({ AI_SPELLCHECK_CONCURRENCY: '1' });
    create.mockResolvedValueOnce(usageOf()).mockRejectedValueOnce(openAiError(500, 'falha'));
    const usage = new AiUsageCollector();
    await expect(service.spellCheck(products(20), { usage })).rejects.toThrow('falha');
    expect(usage.snapshot()).toMatchObject({ calls: 1, inputTokens: 1000, outputTokens: 200 });
  });

  it('com gpt-4o (sem preço): tokens somados e custo nulo', async () => {
    const { service, create } = build({ OPENAI_SPELLCHECK_MODEL: 'gpt-4o' });
    create.mockImplementation(async () => usageOf());
    const usage = new AiUsageCollector();
    await service.spellCheck(products(3), { usage });
    expect(usage.snapshot()).toMatchObject({ model: 'gpt-4o', inputTokens: 1000, costUsd: null });
  });

  it('um coletor somando duas features: categorização (padrão) e depois ortografia com gpt-4o', async () => {
    const categorization = new ProductCategorizationService(
      fakeConfig({ OPENAI_API_KEY: 'sk-teste' }),
    );
    const categorizationCreate = installFakeOpenAi(categorization);
    spyOnLogger(categorization);
    categorizationCreate.mockResolvedValue({
      ...chatResponse({
        content: JSON.stringify({
          assignments: [
            { productId: 'p-0', category: 'Mercearia', confidence: 0.9, source: 'ai', reason: 'x' },
          ],
        }),
      }),
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });
    const { service, create } = build({ OPENAI_SPELLCHECK_MODEL: 'gpt-4o' });
    create.mockImplementation(async () => usageOf());
    const usage = new AiUsageCollector();

    await categorization.categorizeProducts(
      { products: [{ id: 'p-0', name: 'Produto 0' }] },
      { usage },
    );
    await service.spellCheck(products(1), { usage });

    expect(categorizationCreate).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(usage.snapshot()).toEqual({
      model: 'gpt-6-luna',
      models: ['gpt-6-luna', 'gpt-4o'],
      calls: 2,
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: null,
    });
  });
});
