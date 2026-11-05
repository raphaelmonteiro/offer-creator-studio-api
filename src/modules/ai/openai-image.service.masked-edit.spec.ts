import { ConfigService } from '@nestjs/config';
import * as sharp from 'sharp';
import {
  SCENE_INVALID_REQUEST_CODE,
  SCENE_TIMEOUT_CODE,
} from '../../shared/providers/openai-scene-call-errors';
import { OpenAiImageService } from './openai-image.service';
import { APIConnectionTimeoutError } from 'openai';

const SCENE = { timeoutMs: 180_000, correlationId: 'corr-edit' };
const PNG_B64 = Buffer.from('png-falso').toString('base64');
const USAGE = {
  input_tokens: 1000,
  output_tokens: 1000,
  input_tokens_details: { image_tokens: 800, text_tokens: 200 },
};

const png = (width: number, height: number, background = '#336699'): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 4, background } })
    .png()
    .toBuffer();

function sdkOk() {
  return {
    withResponse: async () => ({
      data: { data: [{ b64_json: PNG_B64 }], usage: USAGE },
      response: { headers: { get: () => 'req-header' } },
      request_id: 'req_edit',
    }),
  };
}

function buildService() {
  const service = new OpenAiImageService(
    new ConfigService({ OPENAI_API_KEY: 'sk-teste', OPENAI_IMAGE_RETRY_BASE_DELAY_MS: '1' }),
  );
  const post = jest.fn();
  const edit = jest.fn();
  (service as unknown as { openai: unknown }).openai = { images: { edit }, post };
  return { service, post, edit };
}

async function options(overrides: Record<string, unknown> = {}) {
  const image = await png(1024, 1024);
  const mask = await png(1024, 1024, '#ffffffff');
  return {
    feature: 'template-scene',
    prompt: 'Na área marcada: deixa o sol mais alaranjado',
    imageBuffer: image,
    size: '1024x1024' as const,
    model: 'gpt-image-2.5-sunburst',
    quality: 'high' as const,
    outputFormat: 'png' as const,
    background: 'opaque' as const,
    sceneCall: SCENE,
    mask: { buffer: mask },
    ...overrides,
  };
}

describe('OpenAiImageService.editImage com máscara (M3)', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('envia JSON em /images/edits com images (plural) e mask em data URL, sem markup', async () => {
    const { service, post, edit } = buildService();
    post.mockReturnValue(sdkOk());
    const input = await options();

    const result = await service.editImage(input);

    expect(edit).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const [path, requestOptions] = post.mock.calls[0];
    expect(path).toBe('/images/edits');
    expect(requestOptions).toMatchObject({ maxRetries: 0, timeout: 180_000 });
    const body = requestOptions.body as Record<string, any>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'background',
        'images',
        'mask',
        'model',
        'n',
        'output_format',
        'prompt',
        'quality',
        'size',
      ].sort(),
    );
    expect(body.images).toHaveLength(1);
    expect(body.images[0].image_url).toMatch(/^data:image\/png;base64,/);
    expect(body.mask.image_url).toMatch(/^data:image\/png;base64,/);
    expect(body).not.toHaveProperty('markup');
    expect(body).not.toHaveProperty('image');
    expect(body).toMatchObject({
      model: 'gpt-image-2.5-sunburst',
      size: '1024x1024',
      quality: 'high',
      output_format: 'png',
      background: 'opaque',
      n: 1,
    });
    expect(result.requestId).toBe('req_edit');
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it('recusa máscara de tamanho diferente antes de ir ao provedor', async () => {
    const { service, post } = buildService();
    const input = await options({ mask: { buffer: await png(512, 512) } });

    await expect(service.editImage(input)).rejects.toMatchObject({
      code: SCENE_INVALID_REQUEST_CODE,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('recusa um size que não é o do recorte', async () => {
    const { service, post } = buildService();
    const input = await options({ size: '1024x1536' });
    await expect(service.editImage(input)).rejects.toMatchObject({
      code: SCENE_INVALID_REQUEST_CODE,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('recusa modelo sem a máscara por JSON conferida', async () => {
    const { service, post } = buildService();
    const input = await options({ model: 'gpt-image-1.5' });
    await expect(service.editImage(input)).rejects.toMatchObject({
      code: SCENE_INVALID_REQUEST_CODE,
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('exige o modo sceneCall', async () => {
    const { service, post } = buildService();
    const input = await options({ sceneCall: undefined });
    await expect(service.editImage(input)).rejects.toThrow('sceneCall');
    expect(post).not.toHaveBeenCalled();
  });

  it('falta de crédito: uma só requisição, erro terminal de quota', async () => {
    const { service, post } = buildService();
    post.mockReturnValue({
      withResponse: async () =>
        Promise.reject(
          Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' }),
        ),
    });
    const input = await options();

    await expect(service.editImage(input)).rejects.toMatchObject({ code: 'quota' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('timeout do cliente é terminal e não repete a chamada paga', async () => {
    const { service, post } = buildService();
    post.mockReturnValue({
      withResponse: async () => Promise.reject(new APIConnectionTimeoutError()),
    });
    const input = await options();
    await expect(service.editImage(input)).rejects.toMatchObject({ code: SCENE_TIMEOUT_CODE });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sem máscara, a edição segue o caminho multipart de sempre (images.edit, uma imagem)', async () => {
    const { service, post, edit } = buildService();
    edit.mockReturnValue(sdkOk());
    const input = await options({ mask: undefined });

    await service.editImage(input);

    expect(post).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0][0]).toHaveProperty('image');
    expect(edit.mock.calls[0][0]).not.toHaveProperty('mask');
  });
});

describe('OpenAiImageService.generateImage transparente no modo da cena', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  const transparent = {
    feature: 'template-scene',
    prompt: 'balão de ar quente',
    size: '1024x1024' as const,
    assetKind: 'transparent' as const,
    model: 'gpt-image-2.5-sunburst',
    quality: 'high' as const,
    sceneCall: SCENE,
  };

  it('envia background transparent e output_format png no modelo conferido', async () => {
    const service = new OpenAiImageService(new ConfigService({ OPENAI_API_KEY: 'sk' }));
    const generate = jest.fn().mockReturnValue(sdkOk());
    (service as unknown as { openai: unknown }).openai = { images: { generate } };

    await service.generateImage(transparent);

    expect(generate.mock.calls[0][0]).toMatchObject({
      background: 'transparent',
      output_format: 'png',
    });
  });

  it('recusa fundo transparente em modelo sem a capacidade conferida, sem rede', async () => {
    const service = new OpenAiImageService(new ConfigService({ OPENAI_API_KEY: 'sk' }));
    const generate = jest.fn();
    (service as unknown as { openai: unknown }).openai = { images: { generate } };

    await expect(
      service.generateImage({ ...transparent, model: 'gpt-image-1.5' }),
    ).rejects.toMatchObject({ code: SCENE_INVALID_REQUEST_CODE });
    expect(generate).not.toHaveBeenCalled();
  });
});
