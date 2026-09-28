import { ProductMetadata } from '../metadata/product-metadata.schema';
import { EanCandidateService, montarIndice } from './ean-candidate.service';

function meta(title: string, brand: string | null, extra: Partial<ProductMetadata> = {}) {
  return {
    title,
    quantity: null,
    alternatives: [{ brand, subBrand: null, variant: null }],
    ean: null,
    ...extra,
  } as unknown as ProductMetadata;
}

const ROWS = [
  {
    id: 'uniao-cristal',
    filename: 'Uniao - cristal 1kg.jpg',
    url: '/u/1',
    metadata: meta('Açúcar Cristal', 'União'),
  },
  {
    id: 'uniao-demerara',
    filename: 'Uniao - demerara 1kg.jpg',
    url: '/u/2',
    metadata: meta('Açúcar Demerara', 'União'),
  },
  // Sem marca no metadata: só a busca vetorial alcança.
  {
    id: 'sem-marca',
    filename: 'Acucar cristal pacote.jpg',
    url: '/u/3',
    metadata: meta('Açúcar Cristal', null),
  },
  {
    id: 'ja-com-ean',
    filename: 'Club Social.png',
    url: '/u/4',
    metadata: meta('Club Social', 'Club Social', { ean: '7622300991333' }),
  },
];

function criar(vizinhos: Array<{ id: string; distance: number }>) {
  const embedding = {
    embedText: jest.fn().mockResolvedValue(new Array(1536).fill(0)),
    searchByMetadataEmbedding: jest.fn().mockResolvedValue(vizinhos),
  };
  const service = new EanCandidateService({} as never, embedding as never);
  return { service, embedding };
}

describe('EanCandidateService.gerar', () => {
  const indice = montarIndice(ROWS);

  it('imagem sem marca, mas semanticamente próxima, entra nas candidatas', async () => {
    const { service } = criar([{ id: 'sem-marca', distance: 0.12 }]);
    const c = await service.gerar('ACUCAR CRISTALCUCAR UNIÃO 1KG', indice);

    const semMarca = c.find((x) => x.imageId === 'sem-marca');
    expect(semMarca).toBeDefined();
    expect(semMarca!.origins).toEqual(['vector']);
    expect(semMarca!.vectorScore).toBeCloseTo(0.88, 2);
  });

  it('registra origem e score de cada fonte, juntando quem veio das duas', async () => {
    const { service } = criar([{ id: 'uniao-cristal', distance: 0.2 }]);
    const c = await service.gerar('ACUCAR CRISTAL UNIÃO 1KG', indice);

    const cristal = c.find((x) => x.imageId === 'uniao-cristal')!;
    expect(cristal.origins.sort()).toEqual(['brand', 'vector']);
    expect(cristal.textScore).toBeGreaterThan(0);
    expect(cristal.vectorScore).toBeCloseTo(0.8, 2);
    expect(cristal.score).toBe(Math.max(cristal.textScore!, cristal.vectorScore!));
    expect(c.map((x) => x.imageId)).toContain('uniao-demerara');
  });

  it('sem embedding disponível, usa só a marca', async () => {
    const { service, embedding } = criar([]);
    embedding.embedText.mockResolvedValue(null);
    const c = await service.gerar('ACUCAR CRISTAL UNIÃO 1KG', indice);
    expect(c.every((x) => x.origins.includes('brand'))).toBe(true);
    expect(embedding.searchByMetadataEmbedding).not.toHaveBeenCalled();
  });

  it('indexa as imagens que já têm EAN', () => {
    expect(indice.porEan.get('7622300991333')?.map((i) => i.id)).toEqual(['ja-com-ean']);
  });
});
