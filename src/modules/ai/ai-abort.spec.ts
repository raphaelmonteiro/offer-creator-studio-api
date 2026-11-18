import { TransientProviderError } from '../../shared/providers/provider-errors';
import { GalleryEmbeddingService } from './gallery-embedding.service';
import { answerEach, build as buildParser, NAMES } from './metadata/product-name-parser.testutil';
import { fakeConfig } from './utils/openai-chat.testutil';

function buildEmbedding() {
  const service = new GalleryEmbeddingService(fakeConfig({ OPENAI_API_KEY: 'sk-teste' }), {
    query: jest.fn(),
  } as never);
  const create = jest.fn().mockResolvedValue({ data: [{ embedding: [0.1] }] });
  (service as unknown as { openai: unknown }).openai = { embeddings: { create } };
  return { service, create };
}

describe('opção signal das chamadas de IA de produto (change 29)', () => {
  it('embedTexts repassa o signal ao SDK', async () => {
    const { service, create } = buildEmbedding();
    const { signal } = new AbortController();

    await service.embedTexts(['CERVEJA'], { signal });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: ['CERVEJA'] }), {
      signal,
    });
  });

  it('embedTexts sem o signal chama o SDK como antes: só o corpo', async () => {
    const { service, create } = buildEmbedding();

    await service.embedTexts(['CERVEJA']);

    expect(create.mock.calls[0]).toHaveLength(1);
  });

  it('embedTexts com o signal já abortado falha como transitório no modo estrito', async () => {
    const { service, create } = buildEmbedding();
    const controller = new AbortController();
    create.mockImplementation(async (_body: unknown, options: { signal: AbortSignal }) => {
      if (options.signal.aborted) throw new Error('Request was aborted.');
      return { data: [{ embedding: [0.1] }] };
    });
    controller.abort();

    await expect(
      service.embedTexts(['CERVEJA'], { signal: controller.signal, strict: true }),
    ).rejects.toBeInstanceOf(TransientProviderError);
  });

  it('a leitura do nome repassa o signal à chamada e, sem ele, a chamada é a de hoje', async () => {
    const { service, create } = buildParser();
    create.mockResolvedValue(answerEach(2));
    const { signal } = new AbortController();

    await service.parseNames(NAMES(2), { signal });
    await service.parseNames(NAMES(2).map((n) => ({ ...n, name: `${n.name} X` })));

    expect(create.mock.calls[0][1].signal).toBe(signal);
    expect(create.mock.calls[1][1]).not.toHaveProperty('signal');
  });
});
