import { ConfigService } from '@nestjs/config';
import { APIConnectionTimeoutError } from 'openai';
import { TerminalProviderError } from '../../shared/providers/provider-errors';
import { OpenAiImageService } from './openai-image.service';
import { SCENE_INVALID_REQUEST_CODE, SCENE_TIMEOUT_CODE } from './openai-image-scene-call';

const PNG_B64 = Buffer.from('png-falso').toString('base64');
const SCENE = { timeoutMs: 180_000, correlationId: 'corr-1' };

const USAGE = {
  input_tokens: 172,
  output_tokens: 4523,
  input_tokens_details: { image_tokens: 0, text_tokens: 172 },
};

function sdkOk() {
  return {
    withResponse: async () => ({
      data: { data: [{ b64_json: PNG_B64 }], usage: USAGE },
      response: { headers: { get: () => 'req-header' } },
      request_id: 'req_123',
    }),
  };
}

function sdkFail(error: unknown) {
  return { withResponse: async () => Promise.reject(error) };
}

function buildService() {
  const config = new ConfigService({
    OPENAI_API_KEY: 'sk-teste',
    OPENAI_IMAGE_RETRY_BASE_DELAY_MS: '1',
  });
  const service = new OpenAiImageService(config);
  const generate = jest.fn();
  const edit = jest.fn();
  (service as unknown as { openai: unknown }).openai = { images: { generate, edit } };
  return { service, generate, edit };
}

const baseOptions = {
  feature: 'template-scene',
  prompt: 'campo verde',
  size: '1920x3840' as const,
  assetKind: 'template' as const,
  model: 'gpt-image-2.5-sunburst',
  quality: 'high' as const,
  outputFormat: 'png' as const,
  sceneCall: SCENE,
};

describe('OpenAiImageService: modo sceneCall', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('gera com timeout por requisição, sem retry do SDK, e devolve usage, custo e requestId', async () => {
    const { service, generate } = buildService();
    generate.mockReturnValue(sdkOk());

    const result = await service.generateImage(baseOptions);

    expect(generate).toHaveBeenCalledTimes(1);
    const [request, sdkOptions] = generate.mock.calls[0];
    expect(sdkOptions).toEqual({ maxRetries: 0, timeout: 180_000 });
    expect(request).toEqual({
      model: 'gpt-image-2.5-sunburst',
      prompt: 'campo verde',
      size: '1920x3840',
      quality: 'high',
      n: 1,
      background: 'opaque',
      output_format: 'png',
    });
    expect(result.usage).toEqual(USAGE);
    expect(result.costUsd).toBe(0.13655);
    expect(result.requestId).toBe('req_123');
    expect(result.outputCompression).toBeUndefined();
    expect(result.image.buffer.toString()).toBe('png-falso');
  });

  it('usa o cabeçalho x-request-id quando o SDK não traz request_id', async () => {
    const { service, generate } = buildService();
    generate.mockReturnValue({
      withResponse: async () => ({
        data: { data: [{ b64_json: PNG_B64 }], usage: USAGE },
        response: { headers: { get: () => 'req-header' } },
      }),
    });
    const result = await service.generateImage(baseOptions);
    expect(result.requestId).toBe('req-header');
  });

  it('custo nulo para modelo sem preço conferido', async () => {
    const { service, generate } = buildService();
    generate.mockReturnValue(sdkOk());
    const result = await service.generateImage({ ...baseOptions, model: 'gpt-image-2.5-flare' });
    expect(result.costUsd).toBeNull();
  });

  it('quota: uma só requisição, sem retentativa', async () => {
    const { service, generate } = buildService();
    generate.mockReturnValue(
      sdkFail(Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' })),
    );

    await expect(service.generateImage(baseOptions)).rejects.toMatchObject({
      constructor: TerminalProviderError,
      code: 'quota',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('5xx: retenta e conclui', async () => {
    const { service, generate } = buildService();
    generate
      .mockReturnValueOnce(sdkFail(Object.assign(new Error('boom'), { status: 503 })))
      .mockReturnValueOnce(sdkOk());

    const result = await service.generateImage(baseOptions);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.requestId).toBe('req_123');
  });

  it('5xx persistente: para depois das tentativas configuradas', async () => {
    const { service, generate } = buildService();
    generate.mockReturnValue(sdkFail(Object.assign(new Error('boom'), { status: 500 })));

    await expect(service.generateImage(baseOptions)).rejects.toThrow('HTTP 500');
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('timeout do cliente é terminal (não repete chamada paga)', async () => {
    const { service, generate } = buildService();
    generate.mockReturnValue(sdkFail(new APIConnectionTimeoutError()));

    await expect(service.generateImage(baseOptions)).rejects.toMatchObject({
      code: SCENE_TIMEOUT_CODE,
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('política de conteúdo (400) passa como veio, sem retentativa', async () => {
    const { service, generate } = buildService();
    const policy = Object.assign(new Error('blocked'), { status: 400, code: 'moderation_blocked' });
    generate.mockReturnValue(sdkFail(policy));

    await expect(service.generateImage(baseOptions)).rejects.toBe(policy);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(['10x10', '4096x1024', '1000x3100'])(
    'recusa o tamanho %s sem chamar a rede',
    async (size) => {
      const { service, generate } = buildService();

      await expect(
        service.generateImage({ ...baseOptions, size: size as `${number}x${number}` }),
      ).rejects.toMatchObject({ code: SCENE_INVALID_REQUEST_CODE });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it('recusa qualidade fora da tabela do modelo', async () => {
    const { service, generate } = buildService();
    await expect(
      service.generateImage({
        ...baseOptions,
        model: 'gpt-image-1.5',
        size: '1024x1024',
        quality: 'max',
      }),
    ).rejects.toMatchObject({ code: SCENE_INVALID_REQUEST_CODE });
    expect(generate).not.toHaveBeenCalled();
  });

  it('editImage também usa o modo da cena', async () => {
    const { service, edit } = buildService();
    edit.mockReturnValue(sdkOk());

    const result = await service.editImage({
      feature: 'template-scene',
      prompt: 'edite',
      imageBuffer: Buffer.from('x'),
      size: '1920x3840',
      model: 'gpt-image-2.5-sunburst',
      quality: 'high',
      outputFormat: 'png',
      sceneCall: SCENE,
    });

    expect(edit.mock.calls[0][1]).toEqual({ maxRetries: 0, timeout: 180_000 });
    expect(result.costUsd).toBe(0.13655);
  });

  it('sem sceneCall o resultado não ganha campos novos', async () => {
    const { service, generate } = buildService();
    generate.mockResolvedValue({ data: [{ b64_json: PNG_B64 }], usage: USAGE });

    const result = await service.generateImage({
      ...baseOptions,
      sceneCall: undefined,
      size: '1024x1024',
    });

    expect(result).not.toHaveProperty('usage');
    expect(result).not.toHaveProperty('costUsd');
    expect(result).not.toHaveProperty('requestId');
    expect(generate.mock.calls[0]).toHaveLength(1);
  });
});
