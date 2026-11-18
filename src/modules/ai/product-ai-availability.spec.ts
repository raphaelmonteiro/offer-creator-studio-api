import { GalleryEmbeddingService } from './gallery-embedding.service';
import { ProductCategorizationService } from './product-categorization.service';
import { SpellCheckService } from './spell-check.service';
import { fakeConfig } from './utils/openai-chat.testutil';

const KEY = { OPENAI_API_KEY: 'sk-teste' };

/** Os três métodos de disponibilidade com o ambiente local (flags de IA em `false`, chave vazia). */
const LOCAL_ENV = {
  OPENAI_API_KEY: '',
  AI_PRODUCT_CATEGORIZATION_ENABLED: 'false',
  AI_SPELLCHECK_ENABLED: 'false',
  AI_GALLERY_EMBEDDING_ENABLED: 'false',
};

const categorization = (env: Record<string, string>) =>
  new ProductCategorizationService(fakeConfig(env));
const spelling = (env: Record<string, string>) => new SpellCheckService(fakeConfig(env));
const embedding = (env: Record<string, string>) =>
  new GalleryEmbeddingService(fakeConfig(env), { query: jest.fn() } as never);

describe('Disponibilidade pública dos serviços de IA de produto (change 28)', () => {
  it('categorização desligada pela flag, com a chave presente: false', () => {
    expect(
      categorization({ ...KEY, AI_PRODUCT_CATEGORIZATION_ENABLED: 'false' }).isAvailable(),
    ).toBe(false);
  });

  it('categorização com flag ausente e chave vazia: false; com a chave: true', () => {
    expect(categorization({ OPENAI_API_KEY: '' }).isAvailable()).toBe(false);
    expect(categorization(KEY).isAvailable()).toBe(true);
  });

  it('ortografia com a chave: true com a flag ausente e false com AI_SPELLCHECK_ENABLED=false', () => {
    expect(spelling(KEY).isAvailable()).toBe(true);
    expect(spelling({ ...KEY, AI_SPELLCHECK_ENABLED: 'false' }).isAvailable()).toBe(false);
    expect(spelling({}).isAvailable()).toBe(false);
  });

  it('embedding com a flag ausente e a chave presente: true, sem chamar a OpenAI', () => {
    const service = embedding(KEY);
    const create = jest.fn();
    (service as unknown as { openai: unknown }).openai = { embeddings: { create } };

    expect(service.isEnabled()).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('ambiente local: os três devolvem false', () => {
    expect(categorization(LOCAL_ENV).isAvailable()).toBe(false);
    expect(spelling(LOCAL_ENV).isAvailable()).toBe(false);
    expect(embedding(LOCAL_ENV).isEnabled()).toBe(false);
  });

  it('a categorização sem chave segue devolvendo o plano de reserva, como antes', async () => {
    const result = await categorization({}).categorizeProducts({
      products: [{ id: 'p1', name: 'Produto' }],
    });

    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].source).toBe('fallback');
  });
});
