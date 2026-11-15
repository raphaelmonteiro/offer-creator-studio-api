import { ConfigService } from '@nestjs/config';
import { ProductCategorizationService } from './product-categorization.service';
import { AI_RESPONSE_FORMATS } from './schemas/ai-response.schemas';
import { PRODUCT_CATEGORIZATION_SYSTEM_PROMPT } from './prompts/product-categorization.prompts';
import {
  chatResponse,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from './utils/openai-chat.testutil';

function build(env: Record<string, string> = {}) {
  const service = new ProductCategorizationService(
    new ConfigService({ OPENAI_API_KEY: 'sk-teste', ...env }),
  );
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

function request(count: number) {
  return {
    products: Array.from({ length: count }, (_, i) => ({ id: `p-${i}`, name: `Produto ${i}` })),
  };
}

/** Responde cada lote com a categoria "Mercearia" para todos os ids que vieram no pedido. */
function answerBatch(body: { messages: Array<{ content: string }> }) {
  const sent = JSON.parse(body.messages[1].content) as { products: Array<{ id: string }> };
  return chatResponse({
    content: JSON.stringify({
      assignments: sent.products.map((product) => ({
        productId: product.id,
        category: 'Mercearia',
        confidence: 0.9,
        source: 'ai',
        reason: 'teste',
      })),
    }),
  });
}

describe('ProductCategorizationService', () => {
  it('padrão novo: gpt-6-luna, max_completion_tokens, reasoning_effort none e temperature 0, sem max_tokens', async () => {
    const { service, create } = build();
    create.mockImplementation(async (body) => answerBatch(body));

    const result = await service.categorizeProducts(request(2));

    expect(result.assignments.map((a) => a.category)).toEqual(['Mercearia', 'Mercearia']);
    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 1300,
      reasoning_effort: 'none',
      temperature: 0,
      response_format: AI_RESPONSE_FORMATS.productCategorization,
      messages: [
        { role: 'system', content: PRODUCT_CATEGORIZATION_SYSTEM_PROMPT },
        { role: 'user', content: expect.any(String) },
      ],
    });
    expect(body).not.toHaveProperty('max_tokens');
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('lote de 40 itens: teto maior que os 3.900 de hoje', async () => {
    const { service, create } = build();
    create.mockImplementation(async (body) => answerBatch(body));

    await service.categorizeProducts(request(40));

    expect(create.mock.calls[0][0].max_completion_tokens).toBeGreaterThan(3900);
  });

  it('volta a gpt-4o-mini pela variável: corpo de hoje, com max_tokens min(4096, 300 + 90n)', async () => {
    const { service, create } = build({ OPENAI_CATEGORIZATION_MODEL: 'gpt-4o-mini' });
    create.mockImplementation(async (body) => answerBatch(body));

    await service.categorizeProducts(request(40));

    const [body, options] = create.mock.calls[0];
    expect(body).toStrictEqual({
      model: 'gpt-4o-mini',
      max_tokens: 3900,
      temperature: 0,
      response_format: AI_RESPONSE_FORMATS.productCategorization,
      messages: [
        { role: 'system', content: PRODUCT_CATEGORIZATION_SYSTEM_PROMPT },
        { role: 'user', content: expect.any(String) },
      ],
    });
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('OPENAI_FAST_TEXT_MODEL e OPENAI_TIMEOUT_MS não mudam a chamada', async () => {
    const { service, create } = build({
      OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini',
      OPENAI_TIMEOUT_MS: '180000',
    });
    create.mockImplementation(async (body) => answerBatch(body));
    await service.categorizeProducts(request(1));
    expect(create.mock.calls[0][0].model).toBe('gpt-6-luna');
    expect(create.mock.calls[0][1].timeout).toBe(60_000);
  });

  it('100 produtos: lotes de 40 em série (40, 40 e 20)', async () => {
    const { service, create } = build();
    let running = 0;
    let peak = 0;
    create.mockImplementation(async (body) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return answerBatch(body);
    });

    const result = await service.categorizeProducts(request(100));

    expect(create).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(
      create.mock.calls.map((c) => JSON.parse(c[0].messages[1].content).products.length),
    ).toEqual([40, 40, 20]);
    expect(result.assignments).toHaveLength(100);
  });

  it('conta sem crédito (insufficient_quota): falha na primeira resposta, sem repetição', async () => {
    const { service, create, logs } = build();
    create.mockRejectedValue(
      openAiError(429, 'You exceeded your current quota', 'insufficient_quota'),
    );

    await expect(service.categorizeProducts(request(3))).rejects.toThrow(/quota/);

    expect(create).toHaveBeenCalledTimes(1);
    expect(logs.error.mock.calls.map((c) => String(c[0]))[0]).toContain('AI operation failed');
  });

  it('erro 5xx do provedor: rejeita com uma só chamada e o log traz a feature e o modelo', async () => {
    const { service, create, logs } = build();
    create.mockRejectedValue(openAiError(503, 'indisponível'));

    await expect(service.categorizeProducts(request(1))).rejects.toThrow('indisponível');

    expect(create).toHaveBeenCalledTimes(1);
    const failed = String(logs.error.mock.calls[0][0]);
    expect(failed).toContain('"feature":"product-categorization.batch"');
    expect(failed).toContain('"model":"gpt-6-luna"');
  });

  it('resposta fora do schema: segunda chamada com o pedido de correção, cada uma com o seu prazo', async () => {
    const { service, create } = build();
    create
      .mockResolvedValueOnce(chatResponse({ content: '{"assignments": 1}' }))
      .mockImplementationOnce(async (body) => answerBatch(body));

    const result = await service.categorizeProducts(request(1));

    expect(result.assignments[0].category).toBe('Mercearia');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].messages[2].content).toContain('previous response was invalid');
    expect(create.mock.calls[0][1]).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
    expect(create.mock.calls[1][1]).toStrictEqual({ maxRetries: 0, timeout: 60_000 });
  });

  it('AI_PRODUCT_CATEGORIZATION_ENABLED=false: "Sem categoria", sem chamada', async () => {
    const { service, create } = build({ AI_PRODUCT_CATEGORIZATION_ENABLED: 'false' });
    const result = await service.categorizeProducts(request(2));
    expect(result.assignments.map((a) => a.category)).toEqual(['Sem categoria', 'Sem categoria']);
    expect(create).not.toHaveBeenCalled();
  });

  it('sem a chave da OpenAI: "Sem categoria", sem chamada', async () => {
    const service = new ProductCategorizationService(new ConfigService({}));
    spyOnLogger(service);
    const result = await service.categorizeProducts(request(1));
    expect(result.assignments[0].category).toBe('Sem categoria');
  });

  it('categoria já existente é preservada sem chamar a OpenAI', async () => {
    const { service, create } = build();
    const result = await service.categorizeProducts({
      products: [{ id: 'p-1', name: 'Arroz', currentCategory: 'Mercearia' }],
    });
    expect(result.assignments[0]).toMatchObject({ category: 'Mercearia', source: 'existing' });
    expect(create).not.toHaveBeenCalled();
  });

  it('resposta válida não gera aviso nem linha de falha', async () => {
    const { service, create, logs } = build();
    create.mockImplementation(async (body) => answerBatch(body));
    await service.categorizeProducts(request(2));
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });
});
