import { SocialSectionLayoutService } from './social-section-layout.service';
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
  const service = new SocialSectionLayoutService(
    fakeConfig({ OPENAI_API_KEY: 'sk-teste', ...env }),
  );
  return { service, create: installFakeOpenAi(service), logs: spyOnLogger(service) };
}

const REQUEST = {
  section: { widthCm: 20, heightCm: 5, widthPreviewPx: 756, heightPreviewPx: 189 },
  elements: [{ id: 'el-1', type: 'text' as const, x: 0, y: 0, width: 100, height: 40, zIndex: 1 }],
  instruction: 'Centralize o texto',
};

const ANSWER = chatResponse({
  content: JSON.stringify({
    reasoning: 'Texto centralizado.',
    actions: [{ targetId: 'el-1', patch: { x: 300 } }],
  }),
});

describe('SocialSectionLayoutService (chat do layout social)', () => {
  it('Layout social em Luna: esforço low, teto da família nova e json_object, com a forma de hoje na resposta', async () => {
    const { service, create } = build();
    create.mockResolvedValueOnce(ANSWER);

    const result = await service.apply(REQUEST as never);

    expect(result.reasoning).toBe('Texto centralizado.');
    expect(result.actions).toEqual([{ targetId: 'el-1', patch: { x: 300 } }]);
    expect(sentTo(create)).toEqual({
      body: {
        model: 'gpt-6-luna',
        reasoning_effort: 'low',
        max_completion_tokens: 8000,
        response_format: { type: 'json_object' },
        messages: expect.any(Array),
      },
      options: { timeout: 60_000, maxRetries: 0 },
    });
  });

  it('Layout social de volta ao modelo de hoje: temperature 0.3 e json_object, sem teto nem esforço', async () => {
    const { service, create } = build({ OPENAI_TEXT_MODEL: 'gpt-4o' });
    create.mockResolvedValueOnce(ANSWER);

    await service.apply(REQUEST as never);

    const { body, options } = sentTo(create);
    expect(body).toEqual({
      model: 'gpt-4o',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: expect.any(Array),
    });
    expect(options).toEqual({ timeout: 60_000, maxRetries: 0 });
  });

  it('Modelo sem preço: o log traz os tokens e o custo nulo, nunca zero', async () => {
    const { service, create, logs } = build({
      OPENAI_TEXT_MODEL: 'gpt-4o',
      OPENAI_COST_TEXT_INPUT_1M_USD: '2.5',
    });
    create.mockResolvedValueOnce({
      ...ANSWER,
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    });

    await service.apply(REQUEST as never);

    const finished = logged(logs.log, 'AI operation finished ');
    expect(finished).toMatchObject({
      feature: 'social-section-layout',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 200,
    });
    expect(finished.estimatedCostUsd).toBeNull();
  });

  it('Falha do provedor: uma única chamada, AI operation failed com o modelo, e o erro sobe', async () => {
    const { service, create, logs } = build();
    create.mockRejectedValue(openAiError(503, 'fora do ar'));

    await expect(service.apply(REQUEST as never)).rejects.toThrow('fora do ar');

    expect(create).toHaveBeenCalledTimes(1);
    expect(logged(logs.error, 'AI operation failed ')).toMatchObject({
      feature: 'social-section-layout',
      model: 'gpt-6-luna',
    });
  });

  it('Forma de hoje: a resposta tem só reasoning e actions', async () => {
    const { service, create } = build();
    create.mockResolvedValueOnce(ANSWER);

    const result = await service.apply(REQUEST as never);

    expect(Object.keys(result).sort()).toEqual(['actions', 'reasoning']);
  });
});
