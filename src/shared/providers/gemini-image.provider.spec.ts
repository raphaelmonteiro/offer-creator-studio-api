import { ConfigService } from '@nestjs/config';
import {
  GEMINI_IMAGE_FALLBACK_MODEL,
  GEMINI_IMAGE_MODEL,
  GeminiImageProvider,
  sniffImageMime,
} from './gemini-image.provider';
import { TerminalProviderError } from './provider-errors';

/** HTTP mockado via jest.spyOn(global.fetch) — repo não usa nock (ver fal-queue.client.spec). */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

function imageResponse() {
  return jsonResponse(200, {
    candidates: [
      {
        content: {
          parts: [
            { text: 'aqui está sua imagem' },
            { inlineData: { mimeType: 'image/png', data: PNG_BASE64 } },
          ],
        },
      },
    ],
  });
}

describe('GeminiImageProvider — Nano Banana Pro (plano §4)', () => {
  const config = {
    get: jest.fn((key: string) => (key === 'GEMINI_API_KEY' ? 'gemini-test-key' : undefined)),
  } as unknown as ConfigService;
  let provider: GeminiImageProvider;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    provider = new GeminiImageProvider(config);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('gera via generateContent com x-goog-api-key, inlineData de referência e responseModalities', async () => {
    fetchSpy.mockResolvedValue(imageResponse());
    const reference = Buffer.from('ref-image');
    const result = await provider.generateImage({
      prompt: 'mascote acenando',
      referenceImages: [reference],
      aspectRatio: '1:1',
    });

    expect(result).toEqual(Buffer.from('fake-png-bytes'));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`,
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gemini-test-key');
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts[0]).toEqual({ text: 'mascote acenando' });
    expect(body.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: reference.toString('base64'),
    });
    expect(body.generationConfig.responseModalities).toEqual(['TEXT', 'IMAGE']);
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '1:1' });
  });

  it('acha a imagem em qualquer part de qualquer candidate (parse tolerante)', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, {
        candidates: [
          { content: { parts: [{ text: 'só texto' }] } },
          { content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] } },
        ],
      }),
    );
    await expect(provider.generateImage({ prompt: 'p' })).resolves.toEqual(
      Buffer.from('fake-png-bytes'),
    );
  });

  it('bloqueio de segurança (200 com blockReason, sem imagem) → content_policy terminal', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    );
    await expect(provider.generateImage({ prompt: 'p' })).rejects.toMatchObject({
      code: 'content_policy',
    });
  });

  it('finishReason IMAGE_SAFETY sem imagem → content_policy terminal', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }),
    );
    await expect(provider.generateImage({ prompt: 'p' })).rejects.toMatchObject({
      code: 'content_policy',
    });
  });

  it('HTTP 403 → quota terminal (sinal de kill-switch, plano §6.4)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, { error: { message: 'billing' } }));
    const promise = provider.generateImage({ prompt: 'p' });
    await expect(promise).rejects.toBeInstanceOf(TerminalProviderError);
    await promise.catch((err: TerminalProviderError) => expect(err.code).toBe('quota'));
  });

  it('modelo primário 404 → cai para o fallback gemini-3-pro-image-preview', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(404, { error: { message: 'not found' } }))
      .mockResolvedValueOnce(imageResponse());
    const result = await provider.generateImage({ prompt: 'p' });

    expect(result).toEqual(Buffer.from('fake-png-bytes'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(GEMINI_IMAGE_MODEL);
    expect(String(fetchSpy.mock.calls[1][0])).toContain(GEMINI_IMAGE_FALLBACK_MODEL);
  });

  it('quota NÃO dispara fallback de modelo (falharia igual e dobraria o gasto de rate)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(403, {}));
    await expect(provider.generateImage({ prompt: 'p' })).rejects.toMatchObject({
      code: 'quota',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sem GEMINI_API_KEY → erro terminal acionável, sem tocar a rede', async () => {
    const emptyConfig = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const bare = new GeminiImageProvider(emptyConfig);
    await expect(bare.generateImage({ prompt: 'p' })).rejects.toMatchObject({
      code: 'missing_api_key',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sniffImageMime detecta png/jpeg/webp pela assinatura', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    const webp = Buffer.concat([Buffer.from('RIFF....WEBP'), Buffer.alloc(4)]);
    expect(sniffImageMime(webp)).toBe('image/webp');
  });
});

/** Change video-formatos-personagem (2.6): modelo das referências configurável com o atual na cadeia de fallback. */
describe('GeminiImageProvider — cadeia de modelos (GEMINI_IMAGE_MODEL_REFS)', () => {
  const config = {
    get: jest.fn((key: string) => (key === 'GEMINI_API_KEY' ? 'gemini-test-key' : undefined)),
  } as unknown as ConfigService;
  let provider: GeminiImageProvider;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    provider = new GeminiImageProvider(config);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('modelChain: pedido → atual → fallback, sem repetição', () => {
    expect(GeminiImageProvider.modelChain('gemini-nano-banana-2.1')).toEqual([
      'gemini-nano-banana-2.1',
      GEMINI_IMAGE_MODEL,
      GEMINI_IMAGE_FALLBACK_MODEL,
    ]);
    expect(GeminiImageProvider.modelChain(undefined)).toEqual([
      GEMINI_IMAGE_MODEL,
      GEMINI_IMAGE_FALLBACK_MODEL,
    ]);
    expect(GeminiImageProvider.modelChain('  ')).toEqual([
      GEMINI_IMAGE_MODEL,
      GEMINI_IMAGE_FALLBACK_MODEL,
    ]);
    expect(GeminiImageProvider.modelChain(GEMINI_IMAGE_FALLBACK_MODEL)).toEqual([
      GEMINI_IMAGE_FALLBACK_MODEL,
      GEMINI_IMAGE_MODEL,
    ]);
  });

  it('modelo configurado gera e é devolvido como modelo efetivo', async () => {
    fetchSpy.mockResolvedValue(imageResponse());
    const result = await provider.generateImageWithModel({
      prompt: 'p',
      model: 'gemini-nano-banana-2.1',
    });
    expect(result.model).toBe('gemini-nano-banana-2.1');
    expect(result.image).toEqual(Buffer.from('fake-png-bytes'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('gemini-nano-banana-2.1');
  });

  it('modelo configurado 404 → cai para o modelo atual (Nano Banana Pro), que fica registrado como efetivo', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(404, { error: { message: 'not found' } }))
      .mockResolvedValueOnce(imageResponse());
    const result = await provider.generateImageWithModel({
      prompt: 'p',
      model: 'gemini-nano-banana-2.1',
    });
    expect(result.model).toBe(GEMINI_IMAGE_MODEL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toContain(GEMINI_IMAGE_MODEL);
  });

  it('cadeia inteira indisponível → o último model_not_found é propagado', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(404, {}));
    await expect(
      provider.generateImageWithModel({ prompt: 'p', model: 'gemini-nano-banana-2.1' }),
    ).rejects.toMatchObject({ code: 'model_not_found' });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
