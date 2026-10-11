import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED, inserirImagem } from './ean/ean-test-db';
import { GalleryEmbeddingService } from './gallery-embedding.service';
import { ProductMetadata } from './metadata/product-metadata.schema';

const BASE: ProductMetadata = {
  title: 'Leite Condensado Moça Lata 395g',
  category: null,
  quantity: { value: 395, unit: 'g' },
  packageType: 'lata',
  pack: null,
  alternatives: [{ brand: 'Moça', subBrand: null, variant: null }],
  ean: null,
  sku: null,
  claims: [],
  promo: null,
  dominantColors: [],
  fieldConfidence: {},
  source: 'name-parse',
  modelVersion: 'dotcompany-v1',
  warnings: [],
};

const d = EAN_IT_ENABLED ? describe : describe.skip;

d('GalleryEmbeddingService.saveImageMetadata (Postgres real)', () => {
  let ds: DataSource;
  let service: GalleryEmbeddingService;
  const imagens: string[] = [];

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
    const config = { get: (_k: string, def?: string) => def } as never;
    service = new GalleryEmbeddingService(config, ds);
  });

  afterEach(async () => {
    if (imagens.length)
      await ds.query(`DELETE FROM gallery_images WHERE id = ANY($1)`, [imagens.splice(0)]);
  });

  afterAll(async () => ds.destroy());

  async function metaDe(id: string): Promise<ProductMetadata> {
    const [row] = await ds.query(`SELECT metadata FROM gallery_images WHERE id = $1`, [id]);
    return row.metadata;
  }

  it('nova extração por visão não apaga o EAN dotcompany', async () => {
    const id = await inserirImagem(ds, 'dotcompany-7896019607636.png', {
      ...BASE,
      ean: '7896019607636',
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanConfidence: 1,
      eanStatus: 'resolved',
    });
    imagens.push(id);

    const gravado = await service.saveImageMetadata(id, {
      ...BASE,
      title: 'Leite Moça 395g',
      source: 'vision',
      modelVersion: 'vision-v2',
    });

    const meta = await metaDe(id);
    expect(meta).toEqual(gravado);
    expect(meta.title).toBe('Leite Moça 395g');
    expect(meta).toMatchObject({
      ean: '7896019607636',
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
      eanConfidence: 1,
      eanStatus: 'resolved',
    });
  });

  it('a limpeza da unicidade OFF não apaga EAN de outra fonte', async () => {
    const id = await inserirImagem(ds, 'a.png', {
      ...BASE,
      ean: '7896019607636',
      eanSource: 'dotcompany',
      eanStatus: 'resolved',
    });
    imagens.push(id);

    await service.saveImageMetadata(
      id,
      { ...BASE, ean: null, eanSource: null, eanStatus: 'review' },
      { clearEanSource: 'off' },
    );

    expect((await metaDe(id)).ean).toBe('7896019607636');
  });
});
