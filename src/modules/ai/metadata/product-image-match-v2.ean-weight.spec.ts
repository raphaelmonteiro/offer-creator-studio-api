import { MetadataEmbeddingMatch } from '../gallery-embedding.service';
import { ProductMetadata } from './product-metadata.schema';
import { ProductImageMatchV2Service } from './product-image-match-v2.service';

/**
 * Regra do peso do EAN (spec `product-image-matching`): o componente de EAN só
 * entra na nota quando o card e a imagem têm EAN. Com EAN de um lado só, a nota
 * usa os mesmos pesos de quando nenhum lado tem — senão toda foto com EAN
 * (ex.: as importadas da DotCompany) ficaria abaixo do auto-aceite.
 */
describe('ProductImageMatchV2Service — peso do EAN', () => {
  const service = new ProductImageMatchV2Service(
    {} as never,
    {} as never,
    { pathSimilarity: () => 1 } as never,
    { get: jest.fn().mockReturnValue('0') } as never,
  );

  const META: ProductMetadata = {
    title: 'Leite Condensado Moça Lata 395g',
    category: { id: 10, path: ['Mercearia', 'Leites'] },
    quantity: { value: 395, unit: 'g' },
    packageType: 'lata',
    pack: null,
    alternatives: [{ brand: 'Moça', subBrand: null, variant: 'tradicional' }],
    ean: null,
    sku: null,
    claims: [],
    promo: null,
    dominantColors: [],
    fieldConfidence: {},
    source: 'name-parse',
    modelVersion: 'test',
    warnings: [],
  };

  const row = (metadata: ProductMetadata): MetadataEmbeddingMatch => ({
    id: 'img',
    filename: 'img.png',
    url: 'http://cdn/img.png',
    thumbnailUrl: null,
    folderId: null,
    folderName: null,
    distance: 0,
    metadata,
    isClientPreferred: false,
  });

  const score = (product: ProductMetadata, image: ProductMetadata): number =>
    (
      service as unknown as {
        scoreCandidate(p: ProductMetadata, r: MetadataEmbeddingMatch): { score: number };
      }
    ).scoreCandidate(product, row(image)).score;

  it('card sem EAN e imagem com EAN: mesma nota da imagem sem EAN, alcançando o auto-aceite', () => {
    const comEan = score(META, { ...META, ean: '7891000100103', eanSource: 'dotcompany' });
    const semEan = score(META, META);
    expect(comEan).toBe(semEan);
    expect(comEan).toBeGreaterThanOrEqual(0.75);
  });

  it('os dois lados com o mesmo EAN: componente de EAN conta inteiro', () => {
    const r = score({ ...META, ean: '7891000100103' }, { ...META, ean: '7891000100103' });
    // nota máxima: todos os componentes em 1 (× 0.8 de confiança vazia)
    expect(r).toBeCloseTo(0.8, 4);
  });

  it('os dois lados com EANs diferentes: EAN conta zero com os pesos com EAN', () => {
    const r = score({ ...META, ean: '7891000100103' }, { ...META, ean: '7891000100110' });
    // brand 0.25 + category 0.15 + text 0.15 + pack 0.05 = 0.60 (× 0.8 de confiança vazia)
    expect(r).toBeCloseTo(0.6 * 0.8, 4);
  });
});
