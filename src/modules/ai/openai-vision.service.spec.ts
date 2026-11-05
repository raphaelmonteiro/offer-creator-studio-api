import { ConfigService } from '@nestjs/config';
import { OpenAiVisionService } from './openai-vision.service';

const INPUT = {
  model: 'gpt-6-luna',
  prompt: 'compare',
  before: Buffer.from('a'),
  after: Buffer.from('b'),
  timeoutMs: 20_000,
  correlationId: 'corr-1',
};

function build(apiKey: string | null = 'sk-teste') {
  const service = new OpenAiVisionService(
    new ConfigService(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
  );
  const create = jest.fn();
  (service as unknown as { openai: unknown }).openai = apiKey
    ? { chat: { completions: { create } } }
    : null;
  return { service, create };
}

describe('OpenAiVisionService', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('envia as duas imagens com detail low, JSON e reasoning_effort low, sem retry do SDK', async () => {
    const { service, create } = build();
    create.mockReturnValue({
      withResponse: async () => ({
        data: {
          choices: [{ message: { content: '{"mudou":"x","atendeu":"sim"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        response: { headers: { get: () => 'req_1' } },
      }),
    });

    const result = await service.compare(INPUT);

    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(options).toEqual({ maxRetries: 0, timeout: 20_000 });
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      response_format: { type: 'json_object' },
      reasoning_effort: 'low',
    });
    const content = body.messages[0].content;
    expect(content[0]).toEqual({ type: 'text', text: 'compare' });
    expect(content[1].image_url.detail).toBe('low');
    expect(content[2].image_url.detail).toBe('low');
    expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(result).toMatchObject({
      text: '{"mudou":"x","atendeu":"sim"}',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      requestId: 'req_1',
    });
  });

  it('modelo fora da família gpt-6 não leva reasoning_effort', async () => {
    const { service, create } = build();
    create.mockReturnValue({
      withResponse: async () => ({
        data: { choices: [{ message: { content: '{}' } }] },
        response: { headers: { get: () => null } },
      }),
    });
    const result = await service.compare({ ...INPUT, model: 'gpt-4o' });
    expect(create.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');
    expect(result).toMatchObject({ usage: null, requestId: null });
  });

  it('sem chave configurada: erro claro, sem chamar a rede', async () => {
    const { service } = build(null);
    await expect(service.compare(INPUT)).rejects.toThrow('OpenAI não configurada');
  });
});
