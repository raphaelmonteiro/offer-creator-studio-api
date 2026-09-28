import { EanReferenceService, extrairJson } from './ean-reference.service';

const EAN = '7896102503722';

function criar(opts: {
  off?: Record<string, unknown> | null;
  cache?: Record<string, unknown> | null;
  env?: Record<string, string>;
  offExiste?: boolean;
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
  let quota: unknown = null;
  const settings = {
    getFresh: jest.fn(async () => quota),
    set: jest.fn(async (_: string, v: unknown) => (quota = v)),
  };
  const env: Record<string, string> = { EAN_WEB_REFERENCE_ENABLED: 'false', ...opts.env };
  const config = { get: (k: string, def?: string) => env[k] ?? def };
  const service = new EanReferenceService(dataSource as never, settings as never, config as never);
  return { service, repo, dataSource, salvos, settings };
}

const HEINZ_OFF = {
  gtin: EAN,
  product_name: 'Ketchup Tradicional Heinz 567g',
  brand_raw: 'Heinz',
  quantity_raw: '567 g',
  image_url: 'https://images.openfoodfacts.org/heinz.jpg',
};

afterEach(() => jest.restoreAllMocks());

describe('EanReferenceService', () => {
  it('usa a base local da OFF e grava no cache', async () => {
    const { service, salvos } = criar({ off: HEINZ_OFF });
    const r = await service.resolver(EAN);

    expect(r.costUsd).toBe(0);
    expect(r.reference).toMatchObject({
      source: 'off',
      name: 'Ketchup Tradicional Heinz 567g',
      brand: 'Heinz',
    });
    expect(salvos[0]).toMatchObject({ ean: EAN, source: 'off' });
  });

  it('sem a tabela off_products, pula a fonte sem erro', async () => {
    const { service } = criar({ off: HEINZ_OFF, offExiste: false });
    expect(await service.daOff(EAN)).toBeNull();
    expect((await service.resolver(EAN)).reference.source).toBe('none');
  });

  it('segunda consulta do mesmo EAN vem do cache, sem tocar a fonte', async () => {
    const { service, dataSource } = criar({
      cache: {
        ean: EAN,
        source: 'off',
        name: 'Ketchup',
        brand: 'Heinz',
        quantity: null,
        imageUrl: null,
        fetchedAt: new Date(),
      },
    });
    const r = await service.resolver(EAN);
    expect(r.reference.name).toBe('Ketchup');
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('cache "none" recente não reconsulta; antigo reconsulta', async () => {
    const recente = criar({ cache: { ean: EAN, source: 'none', fetchedAt: new Date() } });
    await recente.service.resolver(EAN);
    expect(recente.dataSource.query).not.toHaveBeenCalled();

    const antigo = criar({
      cache: { ean: EAN, source: 'none', fetchedAt: new Date(Date.now() - 40 * 864e5) },
      off: HEINZ_OFF,
    });
    const r = await antigo.service.resolver(EAN);
    expect(r.reference.source).toBe('off');
  });

  describe('Cosmos', () => {
    it('fica desligado sem token', async () => {
      const spy = jest.spyOn(global, 'fetch');
      const { service } = criar({});
      expect(await service.doCosmos(EAN)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('lê descrição, marca e miniatura', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            description: 'KETCHUP HEINZ 567G',
            brand: { name: 'HEINZ' },
            thumbnail: 'https://c/t.png',
          }),
          { status: 200 },
        ),
      );
      const { service } = criar({ env: { COSMOS_API_TOKEN: 'tok' } });
      expect(await service.doCosmos(EAN)).toMatchObject({
        source: 'cosmos',
        name: 'KETCHUP HEINZ 567G',
        brand: 'HEINZ',
        imageUrl: 'https://c/t.png',
      });
    });

    it('429 vira erro; a cascata registra e segue para a próxima fonte', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
      const { service } = criar({ env: { COSMOS_API_TOKEN: 'tok' } });
      await expect(service.doCosmos(EAN)).rejects.toThrow(/429/);

      const r = await service.resolver(EAN);
      expect(r.reference.source).toBe('none');
    });

    it('respeita a cota diária', async () => {
      const spy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(
          async () => new Response(JSON.stringify({ description: 'X' }), { status: 200 }),
        );
      const { service } = criar({ env: { COSMOS_API_TOKEN: 'tok', COSMOS_DAILY_QUOTA: '2' } });
      await service.doCosmos(EAN);
      await service.doCosmos(EAN);
      expect(await service.doCosmos(EAN)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('busca web', () => {
    function comOpenAi(service: EanReferenceService, outputText: string) {
      (service as unknown as { openai: unknown }).openai = {
        responses: {
          create: jest.fn().mockResolvedValue({
            output_text: outputText,
            usage: { input_tokens: 1000, output_tokens: 100 },
          }),
        },
      };
    }
    const RESPOSTA = JSON.stringify({
      found: true,
      name: 'Ketchup Heinz Tradicional 567g',
      brand: 'Heinz',
      quantity: '567g',
      imageUrl: 'https://loja/heinz.jpg',
      sources: ['https://loja/produto/heinz'],
    });

    it('aceita quando a página citada contém o GTIN exato', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(`<p>EAN: 789 6102 50372-2</p>`, { status: 200 }));
      const { service } = criar({ env: { EAN_WEB_REFERENCE_ENABLED: 'true' } });
      comOpenAi(service, RESPOSTA);

      const { r, costUsd } = await service.daWeb(EAN);
      expect(r).toMatchObject({ source: 'web', name: 'Ketchup Heinz Tradicional 567g' });
      // gpt-4o-mini por padrão: US$0,15 / US$0,60 por 1M tokens
      expect(costUsd).toBeCloseTo(0.01 + 1000 * 0.15e-6 + 100 * 0.6e-6, 6);
    });

    it('descarta quando a página não contém o GTIN (vira "sem referência")', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(`<p>EAN 7896102500011</p>`, { status: 200 }));
      const { service } = criar({ env: { EAN_WEB_REFERENCE_ENABLED: 'true' } });
      comOpenAi(service, RESPOSTA);

      expect((await service.daWeb(EAN)).r).toBeNull();
      const r = await service.resolver(EAN);
      expect(r.reference.source).toBe('none');
      expect(r.costUsd).toBeGreaterThan(0);
    });

    it('found=false não baixa página nenhuma', async () => {
      const spy = jest.spyOn(global, 'fetch');
      const { service } = criar({ env: { EAN_WEB_REFERENCE_ENABLED: 'true' } });
      comOpenAi(service, '{"found": false}');
      expect((await service.daWeb(EAN)).r).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('cascata: OFF vazia → Cosmos responde; web nem é consultada', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ description: 'AGUA SANITARIA SUPREMA 2L' }), { status: 200 }),
      );
    const { service } = criar({
      env: { COSMOS_API_TOKEN: 'tok', EAN_WEB_REFERENCE_ENABLED: 'true' },
    });
    const create = jest.fn();
    (service as unknown as { openai: unknown }).openai = { responses: { create } };

    const r = await service.resolver(EAN);
    expect(r.reference.source).toBe('cosmos');
    expect(create).not.toHaveBeenCalled();
  });

  it('confere a fonte citada pela busca quando a do modelo falha; ignora PDF e texto', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async (url) =>
        String(url).includes('mercado')
          ? new Response('EAN 7896102503722', { status: 200 })
          : new Response('nada', { status: 200 }),
      );
    const { service } = criar({ env: { EAN_WEB_REFERENCE_ENABLED: 'true' } });
    (service as unknown as { openai: unknown }).openai = {
      responses: {
        create: jest.fn().mockResolvedValue({
          output_text: JSON.stringify({
            found: true,
            name: 'Ketchup Heinz',
            sources: [
              'mixalimentos.com.br (tabela)',
              'https://x/catalogo.pdf',
              'https://loja/errada',
            ],
          }),
          output: [
            {
              content: [
                { annotations: [{ type: 'url_citation', url: 'https://mercado/ketchup' }] },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      },
    };

    const { r } = await service.daWeb(EAN);
    expect(r).toMatchObject({ source: 'web', name: 'Ketchup Heinz' });
    const baixadas = spy.mock.calls.map((c) => String(c[0]));
    expect(baixadas).toEqual(['https://loja/errada', 'https://mercado/ketchup']);
  });

  it('extrairJson tolera texto em volta e rejeita lixo', () => {
    expect(extrairJson('Aqui está: {"found": true, "name": "X"} fim')).toEqual({
      found: true,
      name: 'X',
    });
    expect(extrairJson('nada')).toBeNull();
  });
});
