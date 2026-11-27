import { FlyerAssemblyPlanService } from './flyer-assembly-plan.service';
import { logged } from './utils/ai-product-chat.testutil';
import {
  chatResponse,
  fakeConfig,
  installFakeOpenAi,
  openAiError,
  sentTo,
  spyOnLogger,
} from './utils/openai-chat.testutil';

function build(env: Record<string, string> = {}) {
  const service = new FlyerAssemblyPlanService(fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env }));
  return { service, create: installFakeOpenAi(service), logs: spyOnLogger(service) };
}

function request(count: number) {
  return {
    template: { id: 't-1', name: 'Ofertas' },
    document: { name: 'Encarte' },
    products: Array.from({ length: count }, (_, i) => ({
      id: `p-${i}`,
      name: `Produto ${i}`,
      price: 9.9,
      unit: 'un',
      category: 'Mercearia',
      hasImage: true,
    })),
  };
}

/** Plano da IA que aloca todos os produtos numa seção só. */
function planAnswer(count: number) {
  const ids = Array.from({ length: count }, (_, i) => `p-${i}`);
  return chatResponse({
    content: JSON.stringify({
      pages: [
        {
          name: 'Pagina 1',
          sections: [
            {
              category: 'Mercearia',
              title: 'Mercearia',
              priority: 1,
              layout: 'dense-grid',
              productIds: ids,
              featuredProductIds: [],
            },
          ],
        },
      ],
      unplacedProductIds: [],
      notes: [],
    }),
  });
}

describe('FlyerAssemblyPlanService (chat do plano de montagem)', () => {
  it('Plano de montagem de 78 produtos: esforço low, teto da família nova maior que o de hoje (5.970) e prazo de 90 s', async () => {
    const { service, create } = build();
    create.mockResolvedValueOnce(planAnswer(78));

    const plan = await service.createPlan(request(78) as never);

    expect(plan.summary.source).toBe('ai');
    const { body, options } = sentTo(create);
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      reasoning_effort: 'low',
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.max_completion_tokens).toBe(14_140);
    expect(body.max_completion_tokens as number).toBeGreaterThan(5970);
    expect(options).toEqual({ timeout: 90_000, maxRetries: 0 });
  });

  it('Plano de volta ao modelo de hoje: max_tokens 5.970 e temperature 0.2, sem esforço', async () => {
    const { service, create } = build({ OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini' });
    create.mockResolvedValueOnce(planAnswer(78));

    await service.createPlan(request(78) as never);

    const { body } = sentTo(create);
    expect(body).toMatchObject({ model: 'gpt-4o-mini', max_tokens: 5970, temperature: 0.2 });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('Modelo fora das duas famílias: sai com os parâmetros de hoje, a rota responde o plano de reserva e o log traz a falha com o modelo', async () => {
    const { service, create, logs } = build({ OPENAI_FAST_TEXT_MODEL: 'gpt-5-mini' });
    create.mockRejectedValue(openAiError(400, 'Unsupported parameter: max_tokens'));

    const plan = await service.createPlan(request(3) as never);

    expect(plan.summary.source).toBe('fallback');
    expect(sentTo(create).body).toMatchObject({
      model: 'gpt-5-mini',
      max_tokens: 1095,
      temperature: 0.2,
    });
    expect(logged(logs.error, 'AI operation failed ')).toMatchObject({
      feature: 'flyer-assembly.plan',
      model: 'gpt-5-mini',
    });
  });

  it('Erro 5xx do provedor: plano de reserva, sem erro HTTP e com uma só chamada', async () => {
    const { service, create } = build();
    create.mockRejectedValue(openAiError(503, 'fora do ar'));

    const plan = await service.createPlan(request(3) as never);

    expect(plan.summary.source).toBe('fallback');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('Resposta cortada pelo teto: o log traz o aviso truncated e a rota segue o caminho de resposta inválida', async () => {
    const { service, create, logs } = build({ OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '0' });
    create.mockResolvedValueOnce(
      chatResponse({ content: '{"pages": [{"name": "Pagina 1"', finishReason: 'length' }),
    );

    const plan = await service.createPlan(request(3) as never);

    expect(plan.summary.source).toBe('fallback');
    expect(logged(logs.warn, 'AI response invalid ')).toMatchObject({
      feature: 'flyer-assembly.plan',
      model: 'gpt-6-luna',
      reason: 'truncated',
    });
  });

  it('Resposta fora do schema: uma segunda chamada sai com o pedido de correção e o seu prazo', async () => {
    const { service, create } = build({ OPENAI_STRUCTURED_RESPONSE_RETRY_ATTEMPTS: '1' });
    create
      .mockResolvedValueOnce(chatResponse({ content: '{"pages": "x"}' }))
      .mockResolvedValueOnce(planAnswer(3));

    const plan = await service.createPlan(request(3) as never);

    expect(plan.summary.source).toBe('ai');
    expect(sentTo(create, 1).options).toEqual({ timeout: 90_000, maxRetries: 0 });
    const messages = sentTo(create, 1).body.messages as Array<{ content: string }>;
    expect(messages[messages.length - 1].content).toContain('The previous response was invalid');
  });
});
