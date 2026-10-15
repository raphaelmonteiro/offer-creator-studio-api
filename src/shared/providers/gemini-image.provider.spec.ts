import { ConfigService } from '@nestjs/config';
import {
  GEMINI_IMAGE_FALLBACK_MODEL,
  GEMINI_IMAGE_MODEL,
  geminiBilledFailure,
  GeminiImageProvider,
  parseGeminiUsage,
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

  describe('uso de tokens da chamada (custo do kit, tarefa 2.6)', () => {
    const usageMetadata = {
      promptTokenCount: 1500,
      candidatesTokenCount: 1140,
      thoughtsTokenCount: 200,
      totalTokenCount: 2840,
      candidatesTokensDetails: [
        { modality: 'IMAGE', tokenCount: 1120 },
        { modality: 'TEXT', tokenCount: 20 },
      ],
    };

    it('parseGeminiUsage lê usageMetadata (com e sem detalhe por modalidade); ausente → null', () => {
      expect(parseGeminiUsage(usageMetadata)).toEqual({
        promptTokens: 1500,
        candidatesTokens: 1140,
        thoughtsTokens: 200,
        outputImageTokens: 1120,
        totalTokens: 2840,
      });
      expect(parseGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5 })).toEqual({
        promptTokens: 10,
        candidatesTokens: 5,
        thoughtsTokens: 0,
        outputImageTokens: null,
        totalTokens: null,
      });
      expect(parseGeminiUsage(undefined)).toBeNull();
    });

    it('generateImageWithModel devolve o uso da chamada que deu certo', async () => {
      const response = imageResponse();
      const body = await response.json();
      fetchSpy.mockResolvedValue(jsonResponse(200, { ...(body as object), usageMetadata }));
      const result = await provider.generateImageWithModel({ prompt: 'p' });
      expect(result.usage).toMatchObject({ promptTokens: 1500, outputImageTokens: 1120 });
    });

    it('describeImagesWithUsage devolve texto, modelo e uso; describeImages segue devolvendo só o texto', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
          usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 30 },
        }),
      );
      const result = await provider.describeImagesWithUsage({
        prompt: 'p',
        images: [Buffer.from('x')],
      });
      expect(result).toEqual({
        text: '{"ok":true}',
        model: 'gemini-3.8-flash',
        usage: {
          promptTokens: 900,
          candidatesTokens: 30,
          thoughtsTokens: 0,
          outputImageTokens: null,
          totalTokens: null,
        },
      });
      await expect(
        provider.describeImages({ prompt: 'p', images: [Buffer.from('x')] }),
      ).resolves.toBe('{"ok":true}');
    });

    it('200 com finishReason IMAGE_SAFETY + usageMetadata: content_policy terminal com a cobrança anexada (modelo + uso)', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }],
          usageMetadata: {
            promptTokenCount: 1800,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 150,
          },
        }),
      );
      const err = await provider
        .generateImageWithModel({ prompt: 'p', model: 'gemini-nano-banana-2.1' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TerminalProviderError);
      expect(err).toMatchObject({ code: 'content_policy' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(geminiBilledFailure(err)).toEqual({
        model: 'gemini-nano-banana-2.1',
        usage: expect.objectContaining({ promptTokens: 1800, thoughtsTokens: 150 }),
      });
    });

    it('200 sem imagem e sem finishReason de safety: no_image_returned com a cobrança anexada', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'sem imagem' }] } }],
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 12 },
        }),
      );
      const err = await provider.generateImageWithModel({ prompt: 'p' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'no_image_returned' });
      expect(geminiBilledFailure(err)?.usage).toMatchObject({ promptTokens: 1000 });
    });

    it('visão 200 sem texto: invalid_provider_output com a cobrança anexada', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(200, {
          candidates: [{ content: { parts: [] } }],
          usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 0 },
        }),
      );
      const err = await provider
        .describeImagesWithUsage({ prompt: 'p', images: [Buffer.from('x')] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'invalid_provider_output' });
      expect(geminiBilledFailure(err)).toEqual({
        model: 'gemini-3.8-flash',
        usage: expect.objectContaining({ promptTokens: 700 }),
      });
    });

    it('erro sem resposta cobrada (403, rede) não leva cobrança', async () => {
      fetchSpy.mockResolvedValue(jsonResponse(403, {}));
      const err = await provider.generateImageWithModel({ prompt: 'p' }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'quota' });
      expect(geminiBilledFailure(err)).toBeNull();
      expect(geminiBilledFailure(new Error('x'))).toBeNull();
      expect(geminiBilledFailure(null)).toBeNull();
    });
  });

  describe('timeout do cliente (2.6: a requisição abortada pode ter sido cobrada)', () => {
    /** fetch que só termina quando o AbortController do provider aborta. */
    const hangingFetch = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('This operation was aborted')),
        );
      });

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('retryOnTimeout: false → provider_timeout terminal após UMA requisição, cobrança estimada anexada (timedOut)', async () => {
      fetchSpy.mockImplementation(hangingFetch);
      const pending = provider
        .generateImageWithModel({
          prompt: 'p',
          model: 'gemini-nano-banana-2.1',
          retryOnTimeout: false,
        })
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(120_000);
      const err = await pending;
      expect(err).toBeInstanceOf(TerminalProviderError);
      expect(err).toMatchObject({ code: 'provider_timeout' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(geminiBilledFailure(err)).toEqual({
        model: 'gemini-nano-banana-2.1',
        usage: null,
        timedOut: true,
      });
    });

    it('sem a opção (legado: keyframes) o timeout segue transitório e re-tenta', async () => {
      fetchSpy.mockImplementation(hangingFetch);
      const pending = provider.generateImageWithModel({ prompt: 'p' }).catch((e: unknown) => e);
      for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(60_000);
      const err = await pending;
      expect(err).not.toBeInstanceOf(TerminalProviderError);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(geminiBilledFailure(err)).toBeNull();
    });
  });

  describe('falha de rede numa geração paga (achado 1 da execução real da 2.6)', () => {
    const fetchFailed = (code?: string) =>
      Object.assign(
        new TypeError('fetch failed'),
        code ? { cause: Object.assign(new Error(code), { code }) } : {},
      );
    const paidCall = () =>
      provider
        .generateImageWithModel({
          prompt: 'p',
          model: 'gemini-nano-banana-2.1',
          retryOnTimeout: false,
        })
        .catch((e: unknown) => e);

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
      ['fetch failed sem código (worker congelado)', undefined],
      ['socket reset', 'ECONNRESET'],
      ['socket fechado pelo servidor', 'UND_ERR_SOCKET'],
    ])(
      '%s → provider_response_lost terminal após UMA requisição, cobrança estimada (networkFailure)',
      async (_name, code) => {
        fetchSpy.mockRejectedValue(fetchFailed(code));
        const err = await paidCall();
        expect(err).toBeInstanceOf(TerminalProviderError);
        expect(err).toMatchObject({ code: 'provider_response_lost' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(geminiBilledFailure(err)).toEqual({
          model: 'gemini-nano-banana-2.1',
          usage: null,
          networkFailure: true,
        });
      },
    );

    it('corpo da resposta interrompido depois do 200 → provider_response_lost com cobrança estimada', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.reject(new TypeError('terminated')),
      } as unknown as Response);
      const err = await paidCall();
      expect(err).toMatchObject({ code: 'provider_response_lost' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(geminiBilledFailure(err)).toMatchObject({ networkFailure: true });
    });

    it.each(['ECONNREFUSED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'])(
      'rede ANTES do envio (%s) continua transitória e re-tenta, sem cobrança',
      async (code) => {
        fetchSpy.mockRejectedValueOnce(fetchFailed(code)).mockResolvedValueOnce(imageResponse());
        const pending = paidCall();
        await jest.advanceTimersByTimeAsync(5_000);
        const result = (await pending) as { model: string };
        expect(result.model).toBe('gemini-nano-banana-2.1');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      },
    );

    it('sem a opção (legado) o fetch failed segue transitório e re-tenta', async () => {
      fetchSpy.mockRejectedValue(fetchFailed());
      const pending = provider.generateImageWithModel({ prompt: 'p' }).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(10_000);
      const err = await pending;
      expect(err).not.toBeInstanceOf(TerminalProviderError);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(geminiBilledFailure(err)).toBeNull();
    });
  });
});
