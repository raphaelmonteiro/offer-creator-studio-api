import { EanReferenceService } from './ean-reference.service';

const EAN = '7896102503722';
const DESC = 'KETCHUP HEINZ 567G TRADICIONAL';

function criar(opts: {
  off?: Record<string, unknown> | null;
  offExiste?: boolean;
  cache?: Record<string, unknown> | null;
}) {
  const salvos: Array<Record<string, unknown>> = [];
  const repo = {
    findOne: jest.fn().mockResolvedValue(opts.cache ?? null),
    save: jest.fn(async (r: Record<string, unknown>) => salvos.push(r)),
  };
  const dataSource = {
    getRepository: () => repo,
    query: jest.fn(async (sql: string) =>
      sql.includes('to_regclass') ? [{ ok: opts.offExiste ?? true }] : opts.off ? [opts.off] : [],
    ),
  };
  return { service: new EanReferenceService(dataSource as never), dataSource, salvos };
}

const HEINZ_OFF = {
  product_name: 'Ketchup Tradicional Heinz 567g',
  brand_raw: 'Heinz',
  quantity_raw: '567 g',
  image_url: 'https://images.openfoodfacts.org/heinz.jpg',
};

describe('EanReferenceService — sem API externa', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => (fetchSpy = jest.spyOn(global, 'fetch')));
  afterEach(() => {
    // Nenhum teste pode sair para a rede: a referência é só local.
    expect(fetchSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  it('usa a base local quando ela conhece o EAN, e grava no cache', async () => {
    const { service, salvos } = criar({ off: HEINZ_OFF });
    const r = await service.resolver(EAN, DESC);
    expect(r).toEqual({
      reference: {
        ean: EAN,
        source: 'off',
        name: 'Ketchup Tradicional Heinz 567g',
        brand: 'Heinz',
        quantity: '567 g',
        imageUrl: HEINZ_OFF.image_url,
      },
      costUsd: 0,
    });
    expect(salvos[0]).toMatchObject({ ean: EAN, source: 'off' });
  });

  it('sem o EAN na base local, a referência é a descrição do cadastro do cliente', async () => {
    const { service, salvos } = criar({ off: null });
    const r = await service.resolver(EAN, DESC);
    expect(r.reference).toEqual({
      ean: EAN,
      source: 'erp',
      name: DESC,
      brand: null,
      quantity: null,
      imageUrl: null,
    });
    expect(r.costUsd).toBe(0);
    expect(salvos).toHaveLength(0); // descrição do cliente não vai para o cache
  });

  it('sem a tabela off_products, cai no cadastro sem erro', async () => {
    const { service } = criar({ off: HEINZ_OFF, offExiste: false });
    expect((await service.resolver(EAN, DESC)).reference.source).toBe('erp');
  });

  it('cache da base local evita nova consulta', async () => {
    const { service, dataSource } = criar({
      cache: {
        ean: EAN,
        source: 'off',
        name: 'Ketchup',
        brand: 'Heinz',
        quantity: null,
        imageUrl: null,
      },
    });
    expect((await service.resolver(EAN, DESC)).reference.name).toBe('Ketchup');
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('cache antigo de web/none é ignorado e o cadastro vale', async () => {
    const { service } = criar({ cache: { ean: EAN, source: 'none' }, off: null });
    expect((await service.resolver(EAN, DESC)).reference.source).toBe('erp');
  });
});
