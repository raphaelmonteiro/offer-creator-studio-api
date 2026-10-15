import OpenAI from 'openai';
import {
  classifyOpenAiError,
  isOpenAiQuotaError,
  OPENAI_NO_SDK_RETRY,
  openAiRetryAfterSeconds,
  withOpenAiRetry,
} from './openai-errors';
import {
  PROVIDER_RETRY_AFTER_MAX_S,
  TerminalProviderError,
  TransientProviderError,
  withRetry,
} from './provider-errors';

const apiError = (status: number, code: string | null, type?: string) =>
  Object.assign(new Error(`${status} ${code ?? ''}`), { status, code, type });

describe('openai-errors — conta sem crédito é terminal (tarefa 2.6)', () => {
  it('insufficient_quota / billing_hard_limit_reached / credit_balance_exhausted (code OU type) → quota', () => {
    for (const code of [
      'insufficient_quota',
      'billing_hard_limit_reached',
      'credit_balance_exhausted',
    ]) {
      expect(isOpenAiQuotaError(apiError(429, code))).toBe(true);
      expect(isOpenAiQuotaError(apiError(429, null, code))).toBe(true);
      const classified = classifyOpenAiError(apiError(429, code));
      expect(classified).toBeInstanceOf(TerminalProviderError);
      expect(classified).toMatchObject({ code: 'quota' });
    }
    // corpo do erro (`error.code`) também vale
    expect(isOpenAiQuotaError({ status: 429, error: { code: 'insufficient_quota' } })).toBe(true);
  });

  it('429 de limite de taxa e 5xx são transitórios; 400 passa como veio; já classificado não muda', () => {
    expect(classifyOpenAiError(apiError(429, 'rate_limit_exceeded'))).toBeInstanceOf(
      TransientProviderError,
    );
    expect(classifyOpenAiError(apiError(503, null))).toBeInstanceOf(TransientProviderError);
    const bad = apiError(400, 'invalid_request_error');
    expect(classifyOpenAiError(bad)).toBe(bad);
    const terminal = new TerminalProviderError('x', 'content_policy');
    expect(classifyOpenAiError(terminal)).toBe(terminal);
    expect(isOpenAiQuotaError(null)).toBe(false);
  });

  it('falha de rede / timeout do SDK é transitória', () => {
    const err = new OpenAI.APIConnectionTimeoutError();
    expect(classifyOpenAiError(err)).toBeInstanceOf(TransientProviderError);
  });

  it('withOpenAiRetry: quota sai na PRIMEIRA resposta (sem re-tentativa); taxa re-tenta', async () => {
    const quota = jest.fn().mockRejectedValue(apiError(429, 'insufficient_quota'));
    await expect(withOpenAiRetry(quota, { baseDelayMs: 1 })).rejects.toMatchObject({
      code: 'quota',
    });
    expect(quota).toHaveBeenCalledTimes(1);

    const rate = jest
      .fn()
      .mockRejectedValueOnce(apiError(429, 'rate_limit_exceeded'))
      .mockResolvedValue('ok');
    await expect(withOpenAiRetry(rate, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(rate).toHaveBeenCalledTimes(2);
  });

  it('SDK real com OPENAI_NO_SDK_RETRY: 429 insufficient_quota faz UMA requisição HTTP e vira quota', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'You exceeded your current quota',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new OpenAI({ apiKey: 'sk-test', fetch: fetchMock });
    await expect(
      withOpenAiRetry(
        () =>
          client.chat.completions.create(
            { model: 'gpt-4o', messages: [{ role: 'user', content: 'oi' }] },
            OPENAI_NO_SDK_RETRY,
          ),
        { baseDelayMs: 1 },
      ),
    ).rejects.toMatchObject({ code: 'quota' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('429 de taxa respeita o Retry-After (o retry do SDK, que o respeitava, está desligado)', () => {
    const withHeaders = (headers: unknown) =>
      Object.assign(apiError(429, 'rate_limit_exceeded', 'requests'), { headers });

    it('retry-after-ms tem prioridade; retry-after em segundos ou data HTTP; teto de 60 s; sem cabeçalho → null', () => {
      const now = Date.parse('2026-10-15T12:00:00Z');
      expect(
        openAiRetryAfterSeconds(
          withHeaders(new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' })),
        ),
      ).toBe(1.5);
      expect(openAiRetryAfterSeconds(withHeaders(new Headers({ 'retry-after': '8' })))).toBe(8);
      expect(openAiRetryAfterSeconds(withHeaders({ 'retry-after': '8' }))).toBe(8); // objeto simples
      expect(
        openAiRetryAfterSeconds(
          withHeaders({ 'retry-after': 'Thu, 15 Oct 2026 12:00:20 GMT' }),
          now,
        ),
      ).toBe(20);
      expect(openAiRetryAfterSeconds(withHeaders({ 'retry-after': '3600' }))).toBe(
        PROVIDER_RETRY_AFTER_MAX_S,
      );
      expect(openAiRetryAfterSeconds(withHeaders({ 'retry-after': 'lixo' }))).toBeNull();
      expect(openAiRetryAfterSeconds(withHeaders(undefined))).toBeNull();
    });

    it('classifyOpenAiError leva a espera para o TransientProviderError', () => {
      const classified = classifyOpenAiError(withHeaders(new Headers({ 'retry-after': '8' })));
      expect(classified).toBeInstanceOf(TransientProviderError);
      expect((classified as TransientProviderError).retryAfterSeconds).toBe(8);
      const bare = classifyOpenAiError(apiError(503, null)) as TransientProviderError;
      expect(bare.retryAfterSeconds).toBeUndefined();
    });

    it('withOpenAiRetry espera o Retry-After entre as tentativas', async () => {
      jest.useFakeTimers();
      try {
        const fn = jest
          .fn()
          .mockRejectedValueOnce(withHeaders(new Headers({ 'retry-after': '8' })))
          .mockResolvedValue('ok');
        const pending = withOpenAiRetry(fn);
        await jest.advanceTimersByTimeAsync(7_900);
        expect(fn).toHaveBeenCalledTimes(1); // ainda dentro da janela pedida
        await jest.advanceTimersByTimeAsync(200);
        await expect(pending).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('SDK real: 429 com retry-after-ms → a segunda requisição sai depois da espera e responde', async () => {
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { message: 'Rate limit', code: 'rate_limit_exceeded', type: 'requests' },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after-ms': '30' },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 'x',
              object: 'chat.completion',
              created: 0,
              model: 'gpt-4o',
              choices: [
                { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'oi' } },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      const client = new OpenAI({ apiKey: 'sk-test', fetch: fetchMock });
      const res = await withOpenAiRetry(() =>
        client.chat.completions.create(
          { model: 'gpt-4o', messages: [{ role: 'user', content: 'oi' }] },
          OPENAI_NO_SDK_RETRY,
        ),
      );
      expect(res.choices[0].message.content).toBe('oi');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('withRetry (provider-errors)', () => {
    it('Retry-After acima do teto espera só PROVIDER_RETRY_AFTER_MAX_S; não espera depois da última tentativa', async () => {
      jest.useFakeTimers();
      try {
        const fn = jest
          .fn()
          .mockRejectedValueOnce(new TransientProviderError('HTTP 429', 3600))
          .mockResolvedValue('ok');
        const pending = withRetry(fn);
        await jest.advanceTimersByTimeAsync(PROVIDER_RETRY_AFTER_MAX_S * 1000);
        await expect(pending).resolves.toBe('ok');

        const failing = jest.fn().mockRejectedValue(new TransientProviderError('HTTP 503', 30));
        const result = withRetry(failing, { attempts: 2 }).catch((e: unknown) => e);
        await jest.advanceTimersByTimeAsync(30_000); // uma espera só (entre a 1ª e a 2ª)
        await expect(result).resolves.toBeInstanceOf(TransientProviderError);
        expect(failing).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
