import { APIConnectionTimeoutError } from 'openai';
import {
  TerminalProviderError,
  TransientProviderError,
} from '../../shared/providers/provider-errors';
import { fakeEmbeddingService } from './gallery-embedding.testutil';
import { openAiError } from './utils/openai-chat.testutil';

describe('GalleryEmbeddingService, modo estrito (change 28)', () => {
  it.each([
    ['503', openAiError(503)],
    ['429 de taxa', openAiError(429, 'taxa', 'rate_limit_exceeded')],
    ['prazo estourado', new APIConnectionTimeoutError()],
  ])('%s com a opção: lança TransientProviderError depois da linha de log', async (_, failure) => {
    const { embedding: service, create, logs } = fakeEmbeddingService();
    create.mockRejectedValue(failure);

    await expect(service.embedTexts(['CERVEJA'], { strict: true })).rejects.toBeInstanceOf(
      TransientProviderError,
    );
    expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('Falha ao gerar embeddings'));
  });

  it.each([
    ['401', openAiError(401)],
    ['400', openAiError(400)],
    ['403', openAiError(403)],
    ['429 sem crédito', openAiError(429, 'sem saldo', 'insufficient_quota')],
  ])('%s com a opção: lança TerminalProviderError', async (_, failure) => {
    const { embedding: service, create } = fakeEmbeddingService();
    create.mockRejectedValue(failure);

    await expect(service.embedText('CERVEJA', { strict: true })).rejects.toBeInstanceOf(
      TerminalProviderError,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([openAiError(401), openAiError(503)])(
    'sem a opção a mesma falha vira null, com a linha de log de hoje',
    async (failure) => {
      const { embedding: service, create, logs } = fakeEmbeddingService();
      create.mockRejectedValue(failure);

      expect(await service.embedTexts(['CERVEJA', 'ABACATE'])).toEqual([null, null]);
      expect(await service.embedText('CERVEJA')).toBeNull();
      expect(logs.error).toHaveBeenCalledWith(expect.stringContaining('Falha ao gerar embeddings'));
    },
  );

  it('desligado com a opção: null por texto, sem lançar e sem chamar a OpenAI', async () => {
    const { embedding: service, create } = fakeEmbeddingService({
      env: {
        OPENAI_API_KEY: 'sk-teste',
        AI_GALLERY_EMBEDDING_ENABLED: 'false',
      },
    });

    expect(await service.embedTexts(['A', 'B'], { strict: true })).toEqual([null, null]);
    expect(create).not.toHaveBeenCalled();
  });

  it('sem chave com a opção: null, sem lançar', async () => {
    const { embedding: service } = fakeEmbeddingService({ env: {} });

    expect(await service.embedText('A', { strict: true })).toBeNull();
  });

  describe('isEnabled()', () => {
    it.each([
      ['flag ausente e chave presente', { OPENAI_API_KEY: 'sk-teste' }, true],
      ['flag false', { OPENAI_API_KEY: 'sk-teste', AI_GALLERY_EMBEDDING_ENABLED: 'false' }, false],
      ['sem chave', {}, false],
      ['flag false e sem chave', { AI_GALLERY_EMBEDDING_ENABLED: 'false' }, false],
    ])('%s', (_, env, expected) => {
      const { embedding: service } = fakeEmbeddingService({ env });
      expect(service.isEnabled()).toBe(expected);
    });
  });
});
