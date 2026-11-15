import { ConfigService } from '@nestjs/config';
import { PixabayService } from './pixabay.service';
import { PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT } from './prompts/image-search.prompts';
import { fetchWithTimeout } from './utils/fetch-with-timeout.util';
import {
  chatResponse,
  installFakeOpenAi,
  openAiError,
  spyOnLogger,
} from './utils/openai-chat.testutil';

jest.mock('./utils/fetch-with-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));

const fetchMock = fetchWithTimeout as unknown as jest.Mock;

function build(env: Record<string, string> = {}) {
  const service = new PixabayService(
    new ConfigService({ OPENAI_API_KEY: 'sk-teste', PIXABAY_API_KEY: 'pk-teste', ...env }),
    {} as never,
    {} as never,
  );
  const create = installFakeOpenAi(service);
  const logs = spyOnLogger(service);
  return { service, create, logs };
}

function pixabayHits() {
  return {
    ok: true,
    json: async () => ({
      hits: [
        {
          id: 1,
          previewURL: 'p',
          webformatURL: 'w',
          largeImageURL: 'l',
          webformatWidth: 10,
          webformatHeight: 10,
        },
      ],
    }),
  };
}

function searchedTerm(): string {
  const url = String(fetchMock.mock.calls[0][0]);
  return new URL(url).searchParams.get('q')!;
}

describe('PixabayService, tradução do termo', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(pixabayHits());
  });

  it('padrão novo: "salsinha" vira "parsley", com gpt-6-luna, esforço none, temperature 0 e max_completion_tokens', async () => {
    const { service, create } = build();
    create.mockResolvedValue(chatResponse({ content: 'parsley' }));

    const result = await service.searchImages('salsinha');

    expect(searchedTerm()).toBe('parsley');
    expect(result.searchTerm).toBe('salsinha');
    expect(result.images).toHaveLength(1);
    const [body, options] = create.mock.calls[0];
    expect(body).toStrictEqual({
      model: 'gpt-6-luna',
      max_completion_tokens: 128,
      reasoning_effort: 'none',
      temperature: 0,
      messages: [
        { role: 'system', content: PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: 'salsinha' },
      ],
    });
    expect(options).toStrictEqual({ maxRetries: 0, timeout: 10_000 });
  });

  it('com OPENAI_TRANSLATION_MODEL=gpt-4o-mini: o corpo de hoje (max_tokens 32 e temperature 0)', async () => {
    const { service, create } = build({ OPENAI_TRANSLATION_MODEL: 'gpt-4o-mini' });
    create.mockResolvedValue(chatResponse({ content: 'parsley' }));

    await service.searchImages('salsinha');

    expect(create.mock.calls[0][0]).toStrictEqual({
      model: 'gpt-4o-mini',
      max_tokens: 32,
      temperature: 0,
      messages: [
        { role: 'system', content: PIXABAY_SEARCH_TRANSLATION_SYSTEM_PROMPT },
        { role: 'user', content: 'salsinha' },
      ],
    });
    expect(create.mock.calls[0][1]).toStrictEqual({ maxRetries: 0, timeout: 10_000 });
  });

  it('OPENAI_FAST_TEXT_MODEL e OPENAI_TIMEOUT_MS não mudam a chamada', async () => {
    const { service, create } = build({
      OPENAI_FAST_TEXT_MODEL: 'gpt-4o-mini',
      OPENAI_TIMEOUT_MS: '180000',
    });
    create.mockResolvedValue(chatResponse({ content: 'parsley' }));
    await service.searchImages('salsinha');
    expect(create.mock.calls[0][0].model).toBe('gpt-6-luna');
    expect(create.mock.calls[0][1].timeout).toBe(10_000);
  });

  it('prazo ajustado pela variável vale só para a tradução', async () => {
    const { service, create } = build({ OPENAI_TRANSLATION_TIMEOUT_MS: '5000' });
    create.mockResolvedValue(chatResponse({ content: 'parsley' }));
    await service.searchImages('salsinha');
    expect(create.mock.calls[0][1].timeout).toBe(5000);
  });

  it('resposta vazia (inclusive por teto esgotado): busca com "salsinha" e aviso com a feature, o modelo e o motivo', async () => {
    const { service, create, logs } = build();
    create.mockResolvedValue(chatResponse({ content: '', finishReason: 'length' }));

    const result = await service.searchImages('salsinha');

    expect(searchedTerm()).toBe('salsinha');
    expect(result.images).toHaveLength(1);
    const warning = logs.warn.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('AI response invalid'));
    expect(warning).toContain('"feature":"image-search.translate-term"');
    expect(warning).toContain('"model":"gpt-6-luna"');
    expect(warning).toContain('"reason":"truncated"');
  });

  it('resposta só com espaços vale como vazia', async () => {
    const { service, create } = build();
    create.mockResolvedValue(chatResponse({ content: '   ' }));
    await service.searchImages('salsinha');
    expect(searchedTerm()).toBe('salsinha');
  });

  it('prazo estourado: busca com o termo original e AI operation failed com a feature e o modelo', async () => {
    const { service, create, logs } = build();
    create.mockRejectedValue(new Error('Request timed out.'));

    await service.searchImages('salsinha');

    expect(searchedTerm()).toBe('salsinha');
    expect(create).toHaveBeenCalledTimes(1);
    const failed = String(logs.error.mock.calls[0][0]);
    expect(failed).toContain('AI operation failed');
    expect(failed).toContain('"feature":"image-search.translate-term"');
    expect(failed).toContain('"model":"gpt-6-luna"');
  });

  it('falha do provedor (5xx): termo original, sem segunda chamada, com linha de falha', async () => {
    const { service, create, logs } = build();
    create.mockRejectedValue(openAiError(503, 'indisponível'));

    await service.searchImages('salsinha');

    expect(searchedTerm()).toBe('salsinha');
    expect(create).toHaveBeenCalledTimes(1);
    expect(logs.lines().some((l) => l.startsWith('AI operation failed'))).toBe(true);
    expect(logs.lines().some((l) => l.includes('usando original'))).toBe(true);
  });

  it('sem a chave da OpenAI: busca com o termo original, sem chamada', async () => {
    const service = new PixabayService(
      new ConfigService({ PIXABAY_API_KEY: 'pk-teste' }),
      {} as never,
      {} as never,
    );
    await service.searchImages('salsinha');
    expect(searchedTerm()).toBe('salsinha');
  });

  it('resposta válida não gera aviso nem linha de falha', async () => {
    const { service, create, logs } = build();
    create.mockResolvedValue(chatResponse({ content: 'parsley' }));
    await service.searchImages('salsinha');
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('sem PIXABAY_API_KEY: rejeita sem chamar a OpenAI', async () => {
    const { service, create } = build({ PIXABAY_API_KEY: '' });
    await expect(service.searchImages('salsinha')).rejects.toThrow('PIXABAY_API_KEY');
    expect(create).not.toHaveBeenCalled();
  });
});
