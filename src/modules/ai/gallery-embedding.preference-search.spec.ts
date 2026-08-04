import { GalleryEmbeddingService } from './gallery-embedding.service';

/**
 * A busca com escopo de cliente roda DUAS queries indexáveis (top-N global via
 * HNSW + preferidas do cliente) e combina em memória, em vez de uma query só
 * com o boost no ORDER BY — que não é indexável e forçava varredura completa.
 *
 * Estes testes travam o resultado dessa combinação: dedupe, ranking com boost
 * e o corte no limite.
 */
describe('GalleryEmbeddingService — busca com escopo de cliente', () => {
  const EMBEDDING = new Array(1536).fill(0.1);
  const BOOST = 0.15;

  function row(id: string, distance: number) {
    return {
      id,
      filename: `${id}.jpg`,
      url: `https://cdn/${id}.jpg`,
      thumbnailUrl: null,
      folderId: null,
      folderName: null,
      distance: String(distance),
    };
  }

  /** Monta o service devolvendo `globalRows`/`preferredRows` por query. */
  function buildService(
    globalRows: ReturnType<typeof row>[],
    preferredRows: ReturnType<typeof row>[],
  ) {
    const query = jest.fn((sql: string) => {
      const isPreferred = sql.includes('client_preferred_images');
      const rows = isPreferred ? preferredRows : globalRows;
      return Promise.resolve(rows.map((r) => ({ ...r, is_client_preferred: isPreferred })));
    });

    const service = new GalleryEmbeddingService(
      { get: jest.fn((_k: string, d?: string) => d) } as never,
      { query } as never,
    );

    return { service, query };
  }

  it('sem clientId roda UMA query e não toca na tabela de preferências', async () => {
    const { service, query } = buildService([row('a', 0.2)], []);

    await service.searchByEmbedding(EMBEDDING, 10);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain('client_preferred_images');
  });

  it('com clientId roda as duas queries, ambas com ORDER BY indexável', async () => {
    const { service, query } = buildService([row('a', 0.2)], [row('b', 0.3)]);

    await service.searchByEmbedding(EMBEDDING, 10, { clientId: 'c1' });

    expect(query).toHaveBeenCalledTimes(2);
    // A forma `coluna <=> vetor` é a única que o índice HNSW atende: nenhuma
    // das duas pode ter aritmética de boost no ORDER BY.
    for (const [sql] of query.mock.calls) {
      expect(sql).toMatch(/ORDER BY gi\.embedding <=> \$1::vector/);
      expect(sql).not.toContain('CASE WHEN');
    }
  });

  it('a preferida vence a global quando está dentro da margem do boost', async () => {
    // 0.30 - 0.15 = 0.15  <  0.20
    const { service } = buildService([row('global', 0.2)], [row('preferida', 0.3)]);

    const result = await service.searchByEmbedding(EMBEDDING, 10, { clientId: 'c1' });

    expect(result.map((r) => r.id)).toEqual(['preferida', 'global']);
    expect(result[0].isClientPreferred).toBe(true);
  });

  it('a global vence quando a preferida está longe demais', async () => {
    // 0.80 - 0.15 = 0.65  >  0.20
    const { service } = buildService([row('global', 0.2)], [row('preferida', 0.8)]);

    const result = await service.searchByEmbedding(EMBEDDING, 10, { clientId: 'c1' });

    expect(result[0].id).toBe('global');
  });

  it('imagem presente nas duas listas não duplica e fica marcada como preferida', async () => {
    const { service } = buildService([row('mesma', 0.25)], [row('mesma', 0.25)]);

    const result = await service.searchByEmbedding(EMBEDDING, 10, { clientId: 'c1' });

    expect(result).toHaveLength(1);
    expect(result[0].isClientPreferred).toBe(true);
  });

  it('respeita o limite após combinar as duas listas', async () => {
    const { service } = buildService(
      [row('g1', 0.1), row('g2', 0.2), row('g3', 0.3)],
      [row('p1', 0.35)],
    );

    const result = await service.searchByEmbedding(EMBEDDING, 2, { clientId: 'c1' });

    expect(result).toHaveLength(2);
    // p1 efetiva = 0.20, empata com g2 mas entra à frente de g3
    expect(result.map((r) => r.id)).toEqual(['g1', 'p1']);
  });

  it('a distância reportada já vem com o boost aplicado (score consistente)', async () => {
    const { service } = buildService([], [row('preferida', 0.5)]);

    const [hit] = await service.searchByEmbedding(EMBEDDING, 10, { clientId: 'c1' });

    expect(hit.distance).toBeCloseTo(0.5 - BOOST, 5);
  });
});
