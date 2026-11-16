import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { describeIfE2eDb, openE2eDb } from '../../shared/testing/e2e-test-db';
import { GalleryProductLinkService } from '../gallery/gallery-product-link.service';
import { ProductAlias, readProductAliases } from '../gallery/product-alias';
import { inserirImagem } from './ean/ean-test-db';
import { GalleryEmbeddingService } from './gallery-embedding.service';
import { visionMetadata } from './metadata/product-metadata.testutil';
import { fakeConfig } from './utils/openai-chat.testutil';

/**
 * Integração da change 02-fix-gallery-alias-loss no banco descartável do harness da 05 (`chroma_x_e2e`): grava o nome
 * pelo serviço de registro, regrava os dados da foto como a leitura por visão faz e lê o nome de volta. A leitura por
 * visão é simulada (o `ProductMetadata` entregue a `saveImageMetadata`): nenhuma chamada à OpenAI. O banco é
 * compartilhado com outras suítes: nome de arquivo único por execução, só as fotos próprias, apagadas pelo id, e a rota
 * de lote não é chamada (ela lê toda foto pendente da tabela).
 */
const RUN = randomUUID().slice(0, 8);

describeIfE2eDb('gallery_images.metadata.aliases sobrevive à regravação dos dados da foto', () => {
  let dataSource: DataSource;
  let links: GalleryProductLinkService;
  let embedding: GalleryEmbeddingService;
  const photos: string[] = [];

  beforeAll(async () => {
    dataSource = await openE2eDb();
    links = new GalleryProductLinkService(dataSource, null as never);
    embedding = new GalleryEmbeddingService(fakeConfig(), dataSource);
  });

  afterEach(async () => {
    const ids = photos.splice(0);
    if (ids.length) await dataSource.query(`DELETE FROM gallery_images WHERE id = ANY($1)`, [ids]);
  });

  afterAll(async () => dataSource?.destroy());

  async function addPhoto(label: string, metadata: Record<string, unknown> = {}): Promise<string> {
    const id = await inserirImagem(dataSource, `aliases-${RUN}-${label}.png`, metadata);
    photos.push(id);
    return id;
  }

  async function metadataOf(id: string): Promise<Record<string, unknown>> {
    const [row] = await dataSource.query(`SELECT metadata FROM gallery_images WHERE id = $1`, [id]);
    return row.metadata;
  }

  async function statusOf(id: string): Promise<string> {
    const [row] = await dataSource.query(
      `SELECT metadata_status AS status FROM gallery_images WHERE id = $1`,
      [id],
    );
    return row.status;
  }

  async function choose(id: string, ...names: string[]): Promise<ProductAlias[]> {
    for (const productName of names) await links.linkProduct(id, { productName });
    return readProductAliases(await metadataOf(id));
  }

  /** O que a rota de lote faz por foto: marca `pending` e regrava os dados lidos. */
  async function reprocess(id: string, title: string): Promise<void> {
    await embedding.setMetadataStatus(id, 'pending');
    await embedding.saveImageMetadata(id, visionMetadata({ title }));
  }

  it('foto sem EAN com 3 nomes, relida, continua com os 3 e o mesmo chosenAt', async () => {
    const id = await addPhoto('tres-nomes');
    const chosen = await choose(id, 'ABACATE', 'ABACATE KG', 'AVOCADO');
    expect(chosen).toHaveLength(3);

    await embedding.saveImageMetadata(id, visionMetadata({ title: 'Abacate kg' }));

    const after = await metadataOf(id);
    expect(after.title).toBe('Abacate kg');
    expect(readProductAliases(after)).toEqual(chosen);
  });

  it('a corrida: envio pendente, escolha e leitura depois, termina ready e com o nome', async () => {
    const id = await addPhoto('corrida');
    await embedding.setMetadataStatus(id, 'pending');
    const chosen = await choose(id, 'ARROZ SOLITO 1KG');

    await embedding.saveImageMetadata(id, visionMetadata({ title: 'Arroz Solito 1kg' }));

    expect(await statusOf(id)).toBe('ready');
    expect(readProductAliases(await metadataOf(id))).toEqual(chosen);
  });

  it('a corrida com as duas gravações ao mesmo tempo: o nome fica em qualquer ordem', async () => {
    const id = await addPhoto('corrida-junta');
    await embedding.setMetadataStatus(id, 'pending');

    await Promise.all([
      links.linkProduct(id, { productName: 'ARROZ SOLITO 1KG' }),
      embedding.saveImageMetadata(id, visionMetadata({ title: 'Arroz Solito 1kg' })),
    ]);

    const after = await metadataOf(id);
    expect(readProductAliases(after).map((a) => a.key)).toEqual(['ARROZ SOLITO 1KG']);
    expect(after.title).toBe('Arroz Solito 1kg');
    expect(await statusOf(id)).toBe('ready');
  });

  it('a ordem inversa: a leitura termina antes da escolha e o nome entra depois', async () => {
    const id = await addPhoto('ordem-inversa');
    await embedding.setMetadataStatus(id, 'pending');
    await embedding.saveImageMetadata(id, visionMetadata({ title: 'Arroz Solito 1kg' }));

    await links.linkProduct(id, { productName: 'ARROZ SOLITO 1KG' });

    const after = await metadataOf(id);
    expect(readProductAliases(after).map((a) => a.name)).toEqual(['ARROZ SOLITO 1KG']);
    expect(after.title).toBe('Arroz Solito 1kg');
    expect(await statusOf(id)).toBe('ready');
  });

  it('foto com EAN dotcompany relida pela visão sem EAN mantém o EAN, a fonte e o nome', async () => {
    const id = await addPhoto(
      'dotcompany',
      visionMetadata({
        source: 'name-parse',
        ean: '7896019607636',
        eanSource: 'dotcompany',
        eanVerifiedBy: 'exact',
        eanConfidence: 1,
        eanStatus: 'resolved',
      }),
    );
    const chosen = await choose(id, 'LEITE COND MOCA 395G');

    await embedding.saveImageMetadata(id, visionMetadata({ title: 'Leite Moça 395g' }));

    const after = await metadataOf(id);
    expect(after).toMatchObject({
      title: 'Leite Moça 395g',
      ean: '7896019607636',
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanStatus: 'resolved',
    });
    expect(readProductAliases(after)).toEqual(chosen);
  });

  it('EAN de fonte melhor chega: o EAN é o novo e o nome continua', async () => {
    const id = await addPhoto(
      'off',
      visionMetadata({ ean: '7896019607999', eanSource: 'off', eanConfidence: 0.7 }),
    );
    const chosen = await choose(id, 'LEITE COND MOCA 395G');

    await embedding.saveImageMetadata(
      id,
      visionMetadata({ ean: '7896019607636', eanSource: 'dotcompany', eanConfidence: 1 }),
    );

    const after = await metadataOf(id);
    expect(after).toMatchObject({ ean: '7896019607636', eanSource: 'dotcompany' });
    expect(readProductAliases(after)).toEqual(chosen);
  });

  it('foto sem nome escolhido continua sem a chave aliases', async () => {
    const id = await addPhoto('sem-nome');

    await embedding.saveImageMetadata(id, visionMetadata({ title: 'Leite Moça 395g' }));

    const after = await metadataOf(id);
    expect(after.title).toBe('Leite Moça 395g');
    expect(after).not.toHaveProperty('aliases');
  });

  it('lote de 3 fotos reprocessadas: cada uma continua com os seus nomes', async () => {
    const batch = [
      { id: await addPhoto('lote-1'), names: ['ARROZ SOLITO 1KG'] },
      { id: await addPhoto('lote-2'), names: ['FEIJAO CARIOCA 1KG', 'FEIJAO KG'] },
      { id: await addPhoto('lote-3'), names: ['ACUCAR REFINADO 1KG', 'ACUCAR 1KG', 'ACUCAR KG'] },
    ];
    const chosen = new Map<string, ProductAlias[]>();
    for (const photo of batch) chosen.set(photo.id, await choose(photo.id, ...photo.names));

    for (const photo of batch) await reprocess(photo.id, `Produto ${photo.names[0]}`);

    for (const photo of batch) {
      expect(readProductAliases(await metadataOf(photo.id))).toEqual(chosen.get(photo.id));
      expect(await statusOf(photo.id)).toBe('ready');
    }
  });
});
