import { ConfigService } from '@nestjs/config';
import {
  buildDirectorRequest,
  DirectorCompletionInput,
  directorTextOf,
  OpenAiDirectorService,
} from './openai-director.service';

const INPUT: DirectorCompletionInput = {
  model: 'gpt-6-luna',
  instructions: 'Você é o diretor.',
  text: 'Cliente: oi',
  image: Buffer.from('jpeg-falso'),
  jsonSchema: { name: 'scene_director', schema: { type: 'object', additionalProperties: false } },
  timeoutMs: 20_000,
  correlationId: 'corr-1',
};

const okResponse = (text = '{"ok":true}') => ({
  data: {
    status: 'completed',
    output: [
      { type: 'reasoning', content: [] },
      { type: 'message', content: [{ type: 'output_text', text }] },
    ],
    usage: { input_tokens: 2600, output_tokens: 350 },
  },
  response: { headers: { get: (name: string) => (name === 'x-request-id' ? 'req_dir' : null) } },
});

function build(create: jest.Mock) {
  const service = new OpenAiDirectorService(new ConfigService({ OPENAI_API_KEY: 'sk-teste' }));
  (service as unknown as { openai: unknown }).openai = { responses: { create } };
  return service;
}

describe('buildDirectorRequest', () => {
  it('/responses com store false, detail high, effort medium e 6000 tokens, sem previous_response_id', () => {
    const body = buildDirectorRequest(INPUT) as Record<string, any>;
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      instructions: 'Você é o diretor.',
      store: false,
      max_output_tokens: 6000,
      reasoning: { effort: 'medium' },
      text: { format: { type: 'json_schema', name: 'scene_director', strict: true } },
    });
    expect(body.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Cliente: oi' },
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${Buffer.from('jpeg-falso').toString('base64')}`,
            detail: 'high',
          },
        ],
      },
    ]);
  });

  it('sem imagem (cena nova) só o texto vai', () => {
    const body = buildDirectorRequest({ ...INPUT, image: null }) as Record<string, any>;
    expect(body.input[0].content).toEqual([{ type: 'input_text', text: 'Cliente: oi' }]);
  });
});

describe('directorTextOf', () => {
  it('junta só o texto das mensagens', () => {
    expect(directorTextOf(okResponse('{"a":1}').data)).toBe('{"a":1}');
  });

  it('resposta incompleta (acabou o teto de tokens) não devolve texto', () => {
    expect(directorTextOf({ ...okResponse().data, status: 'incomplete' })).toBe('');
  });

  it('resposta sem mensagem devolve vazio', () => {
    expect(directorTextOf({ status: 'completed', output: [{ type: 'reasoning' }] })).toBe('');
    expect(directorTextOf({})).toBe('');
  });
});

describe('OpenAiDirectorService', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('uma requisição, sem retry do SDK e com o tempo máximo, e devolve texto, usage e requestId', async () => {
    const withResponse = jest.fn().mockResolvedValue(okResponse());
    const create = jest.fn().mockReturnValue({ withResponse });
    const result = await build(create).plan(INPUT);

    expect(create).toHaveBeenCalledTimes(1);
    const [body, options] = create.mock.calls[0];
    expect(options).toEqual({ maxRetries: 0, timeout: 20_000 });
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body.store).toBe(false);
    expect(result).toMatchObject({
      text: '{"ok":true}',
      usage: { input_tokens: 2600, output_tokens: 350 },
      requestId: 'req_dir',
    });
  });

  it('erro do provedor passa como veio (quota é do chamador classificar)', async () => {
    const quota = Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' });
    const create = jest.fn().mockReturnValue({ withResponse: () => Promise.reject(quota) });
    await expect(build(create).plan(INPUT)).rejects.toBe(quota);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('sem chave configurada falha antes da rede', async () => {
    const service = new OpenAiDirectorService(new ConfigService({}));
    await expect(service.plan(INPUT)).rejects.toThrow('OpenAI não configurada');
  });
});
