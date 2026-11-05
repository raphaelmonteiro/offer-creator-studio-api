import { ConfigService } from '@nestjs/config';
import { parseIntent } from '../template-scenes/domain/scene-intent';
import { OpenAiIntentService } from './openai-intent.service';

const INPUT = {
  model: 'gpt-6-luna',
  system: 'regras',
  user: 'deixa mais quente',
  jsonSchema: { name: 'scene_intent', schema: { type: 'object' } },
  timeoutMs: 8000,
  correlationId: 'corr-1',
};

function build(apiKey: string | null = 'sk-teste') {
  const service = new OpenAiIntentService(
    new ConfigService(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
  );
  const create = jest.fn();
  (service as unknown as { openai: unknown }).openai = apiKey
    ? { chat: { completions: { create } } }
    : null;
  return { service, create };
}

describe('OpenAiIntentService', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('envia só texto, com schema fechado, reasoning_effort low e sem retry do SDK', async () => {
    const { service, create } = build();
    create.mockReturnValue({
      withResponse: async () => ({
        data: {
          choices: [{ message: { content: '{"action":"edit"}' } }],
          usage: { prompt_tokens: 900, completion_tokens: 120 },
        },
        response: { headers: { get: () => 'req_9' } },
      }),
    });

    const result = await service.classify(INPUT);

    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(options).toEqual({ maxRetries: 0, timeout: 8000 });
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'scene_intent', strict: true, schema: { type: 'object' } },
      },
      reasoning_effort: 'low',
      max_completion_tokens: 1000,
    });
    expect(body.messages).toEqual([
      { role: 'system', content: 'regras' },
      { role: 'user', content: 'deixa mais quente' },
    ]);
    expect(JSON.stringify(body)).not.toContain('image_url');
    expect(result).toEqual({
      text: '{"action":"edit"}',
      usage: { prompt_tokens: 900, completion_tokens: 120 },
      requestId: 'req_9',
      latencyMs: expect.any(Number),
    });
  });

  it('modelo que não é da família gpt-6 não leva reasoning_effort', async () => {
    const { service, create } = build();
    create.mockReturnValue({
      withResponse: async () => ({
        data: { choices: [{ message: { content: '{}' } }] },
        response: { headers: { get: () => null } },
      }),
    });
    await service.classify({ ...INPUT, model: 'outro-modelo' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');
  });

  it('recusa do modelo (conteúdo nulo) vira texto vazio, que o parser recusa como JSON inválido', async () => {
    const { service, create } = build();
    create.mockReturnValue({
      withResponse: async () => ({
        data: {
          choices: [{ message: { content: null, refusal: 'Não posso ajudar com isso.' } }],
          usage: { prompt_tokens: 900, completion_tokens: 5 },
        },
        response: { headers: { get: () => 'req_r' } },
      }),
    });

    const result = await service.classify(INPUT);

    expect(result.text).toBe('');
    expect(parseIntent(result.text, 'deixa mais quente')).toEqual({
      ok: false,
      reason: 'JSON inválido',
    });
  });

  it('sem chave configurada, falha sem chamar a rede', async () => {
    const { service } = build(null);
    await expect(service.classify(INPUT)).rejects.toThrow('OpenAI não configurada');
  });

  it('o erro da API sobe sem retentativa', async () => {
    const { service, create } = build();
    create.mockReturnValue({
      withResponse: async () => {
        throw new Error('429');
      },
    });
    await expect(service.classify(INPUT)).rejects.toThrow('429');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
