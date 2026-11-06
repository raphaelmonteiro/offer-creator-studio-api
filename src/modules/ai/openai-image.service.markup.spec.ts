import { ConfigService } from '@nestjs/config';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import OpenAI from 'openai';
import * as sharp from 'sharp';
import { SCENE_INVALID_REQUEST_CODE } from '../../shared/providers/openai-scene-call-errors';
import { OpenAiImageService } from './openai-image.service';

const SCENE = { timeoutMs: 30_000, correlationId: 'corr-markup' };
const MODEL = 'gpt-image-2.6-sunburst';
const USAGE = {
  input_tokens: 2100,
  output_tokens: 1000,
  input_tokens_details: { image_tokens: 2000, text_tokens: 100 },
};
const PNG_B64 = Buffer.from('png-falso').toString('base64');

const png = (width: number, height: number, alpha = 1) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 20, b: 20, alpha } },
  })
    .png()
    .toBuffer();

function sdkOk() {
  return {
    withResponse: async () => ({
      data: { data: [{ b64_json: PNG_B64 }], usage: USAGE },
      response: { headers: { get: () => null } },
      request_id: 'req_markup',
    }),
  };
}

function buildService() {
  const service = new OpenAiImageService(
    new ConfigService({ OPENAI_API_KEY: 'sk-teste', OPENAI_IMAGE_RETRY_BASE_DELAY_MS: '1' }),
  );
  const generate = jest.fn();
  const edit = jest.fn();
  (service as unknown as { openai: unknown }).openai = { images: { generate, edit } };
  return { service, generate, edit };
}

async function editOptions(overrides: Record<string, unknown> = {}) {
  return {
    feature: 'template-scene',
    prompt: 'Dentro do retângulo da camada de marcação: tire o coelho.',
    imageBuffer: await png(64, 80),
    imageMimeType: 'image/png',
    markup: { buffer: await png(64, 80, 0) },
    size: '64x80' as `${number}x${number}`,
    model: MODEL,
    quality: 'high' as const,
    outputFormat: 'png' as const,
    background: 'opaque' as const,
    sceneCall: SCENE,
    ...overrides,
  };
}

describe('OpenAiImageService: edição com markup', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  describe('Pedido com marcação', () => {
    it('envia image e markup como arquivos PNG, sem mask, em uma requisição sem retry do SDK', async () => {
      const { service, edit } = buildService();
      edit.mockReturnValue(sdkOk());
      const options = await editOptions({ size: '64x80' });
      // 64x80 está fora do mínimo de área do modelo: o teste de corpo usa o tamanho de produção.
      const big = await png(1152, 1440);
      const bigMarkup = await png(1152, 1440, 0);

      const result = await service.editImage({
        ...options,
        imageBuffer: big,
        markup: { buffer: bigMarkup },
        size: '1152x1440',
      });

      expect(edit).toHaveBeenCalledTimes(1);
      const [request, sdkOptions] = edit.mock.calls[0];
      expect(sdkOptions).toEqual({ maxRetries: 0, timeout: 30_000 });
      expect(request).not.toHaveProperty('mask');
      expect(request).not.toHaveProperty('input_fidelity');
      expect(request.model).toBe(MODEL);
      expect(request.image.type).toBe('image/png');
      expect(request.markup.type).toBe('image/png');
      expect(request.markup.name).toBe('markup.png');
      expect(request).toMatchObject({
        size: '1152x1440',
        quality: 'high',
        output_format: 'png',
        background: 'opaque',
        n: 1,
      });
      expect(result.costUsd).toBe(0.0465);
    });

    it('sem markup o corpo não ganha a chave', async () => {
      const { service, edit } = buildService();
      edit.mockReturnValue(sdkOk());
      const options = await editOptions();
      const { markup: _markup, ...withoutMarkup } = options;
      await service.editImage({ ...withoutMarkup, size: '1152x1440' });
      expect(edit.mock.calls[0][0]).not.toHaveProperty('markup');
    });

    it('recusa markup de outro tamanho antes da rede', async () => {
      const { service, edit } = buildService();
      const options = await editOptions({ markup: { buffer: await png(32, 40, 0) } });
      await expect(service.editImage(options)).rejects.toMatchObject({
        code: SCENE_INVALID_REQUEST_CODE,
        message: expect.stringContaining('precisa ter o tamanho da imagem'),
      });
      expect(edit).not.toHaveBeenCalled();
    });

    it('recusa tamanho pedido diferente da imagem, markup ilegível e modelo sem a capacidade', async () => {
      const { service, edit } = buildService();
      await expect(
        service.editImage(await editOptions({ size: '1152x1440' })),
      ).rejects.toMatchObject({ code: SCENE_INVALID_REQUEST_CODE });
      await expect(
        service.editImage(await editOptions({ markup: { buffer: Buffer.from('nao-e-png') } })),
      ).rejects.toMatchObject({ code: SCENE_INVALID_REQUEST_CODE });
      await expect(
        service.editImage(
          await editOptions({
            model: 'gpt-image-2.5-sunburst',
            imageBuffer: await png(1152, 1440),
            markup: { buffer: await png(1152, 1440, 0) },
            size: '1152x1440',
          }),
        ),
      ).rejects.toMatchObject({ code: SCENE_INVALID_REQUEST_CODE });
      expect(edit).not.toHaveBeenCalled();
    });

    it('markup sem sceneCall é erro de programação', async () => {
      const { service } = buildService();
      await expect(service.editImage(await editOptions({ sceneCall: undefined }))).rejects.toThrow(
        'só existe no modo sceneCall',
      );
    });
  });

  describe('Falha do provedor', () => {
    it('insufficient_quota: uma única requisição e erro terminal de quota', async () => {
      const { service, edit } = buildService();
      edit.mockReturnValue({
        withResponse: async () =>
          Promise.reject(
            Object.assign(new Error('quota'), { status: 429, code: 'insufficient_quota' }),
          ),
      });
      const options = await editOptions({
        imageBuffer: await png(1152, 1440),
        markup: { buffer: await png(1152, 1440, 0) },
        size: '1152x1440',
      });
      await expect(service.editImage(options)).rejects.toMatchObject({ code: 'quota' });
      expect(edit).toHaveBeenCalledTimes(1);
    });
  });
});

/** Parte de um corpo multipart: nome do campo, `Content-Type` e conteúdo. */
interface Part {
  name: string;
  filename?: string;
  contentType?: string;
  body: Buffer;
}

function parseMultipart(contentType: string, raw: Buffer): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const marker = Buffer.from(`--${boundary?.[1] ?? boundary?.[2]}`);
  const parts: Part[] = [];
  let start = raw.indexOf(marker);
  while (start !== -1) {
    const next = raw.indexOf(marker, start + marker.length);
    if (next === -1) break;
    const chunk = raw.subarray(start + marker.length + 2, next - 2);
    const split = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, split).toString();
    parts.push({
      name: /name="([^"]+)"/.exec(head)?.[1] ?? '',
      filename: /filename="([^"]*)"/.exec(head)?.[1],
      contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1],
      body: chunk.subarray(split + 4),
    });
    start = next;
  }
  return parts;
}

describe('OpenAiImageService: markup contra um servidor HTTP local', () => {
  let server: Server;
  let received: { contentType: string; body: Buffer }[] = [];
  let baseURL = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          contentType: String(req.headers['content-type']),
          body: Buffer.concat(chunks),
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ b64_json: PNG_B64 }], usage: USAGE }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    received = [];
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function realSdkService() {
    const service = new OpenAiImageService(new ConfigService({ OPENAI_API_KEY: 'sk-teste' }));
    (service as unknown as { openai: unknown }).openai = new OpenAI({
      apiKey: 'sk-teste',
      baseURL,
      maxRetries: 0,
    });
    return service;
  }

  it('multipart com image e markup como image/png, mais os campos de texto', async () => {
    const service = realSdkService();
    const image = await png(1152, 1440);
    const markup = await png(1152, 1440, 0);

    await service.editImage({
      feature: 'template-scene',
      prompt: 'Dentro do retângulo da camada de marcação: tire o coelho.',
      imageBuffer: image,
      imageMimeType: 'image/png',
      markup: { buffer: markup },
      size: '1152x1440',
      model: MODEL,
      quality: 'high',
      outputFormat: 'png',
      background: 'opaque',
      sceneCall: SCENE,
    });

    expect(received).toHaveLength(1);
    expect(received[0].contentType).toContain('multipart/form-data');
    const parts = parseMultipart(received[0].contentType, received[0].body);
    const byName = Object.fromEntries(parts.map((part) => [part.name, part]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        'background',
        'image',
        'markup',
        'model',
        'n',
        'output_format',
        'prompt',
        'quality',
        'size',
      ].sort(),
    );
    expect(byName.image.contentType).toBe('image/png');
    expect(byName.markup.contentType).toBe('image/png');
    expect(byName.markup.filename).toBe('markup.png');
    expect(Buffer.compare(byName.image.body, image)).toBe(0);
    expect(Buffer.compare(byName.markup.body, markup)).toBe(0);
    expect(byName.model.body.toString()).toBe(MODEL);
    expect(byName.size.body.toString()).toBe('1152x1440');
    expect(byName.quality.body.toString()).toBe('high');
    expect(byName.output_format.body.toString()).toBe('png');
    expect(byName.background.body.toString()).toBe('opaque');
    expect(byName.n.body.toString()).toBe('1');
    expect(byName).not.toHaveProperty('mask');
    expect(byName).not.toHaveProperty('input_fidelity');
  });

  it('sem markup, o multipart não traz o campo', async () => {
    const service = realSdkService();
    await service.editImage({
      feature: 'template-scene',
      prompt: 'ajuste',
      imageBuffer: await png(1152, 1440),
      imageMimeType: 'image/png',
      size: '1152x1440',
      model: MODEL,
      quality: 'high',
      outputFormat: 'png',
      background: 'opaque',
      sceneCall: SCENE,
    });
    const parts = parseMultipart(received[0].contentType, received[0].body);
    expect(parts.map((part) => part.name)).not.toContain('markup');
  });
});
