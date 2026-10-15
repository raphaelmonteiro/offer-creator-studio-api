// O serviço puxa o importador de fotos → sharp, que não carrega no host.
jest.mock('sharp', () => jest.fn());

import { DataSource } from 'typeorm';
import { criarDataSourceDeTeste, EAN_IT_ENABLED, inserirImagem } from '../ean-test-db';
import { DotcompanyLookupService, LookupOutcome } from './dotcompany-lookup.service';
import { FlyerEanResolutionService } from './flyer-ean-resolution.service';

/**
 * Resolução por EAN do encarte contra Postgres real (galeria e preferências),
 * com DotCompany, fotos e casamento por nome falsos:
 *
 *   EAN_IT_DB_PORT=5433 EAN_IT_DB_NAME=ean_mig_test npx jest flyer-ean-resolution
 */
const d = EAN_IT_ENABLED ? describe : describe.skip;

const NA_GALERIA = '7891000100103'; // Moça
const NOVO = '7622300873554'; // Oreo — só na DotCompany
const INEXISTENTE = '7891000999998';
const CLIENTE = '0b5c7a3e-0000-4000-8000-0000000000c1';

d('FlyerEanResolutionService (Postgres real)', () => {
  let ds: DataSource;
  const imagens: string[] = [];

  beforeAll(async () => {
    ds = criarDataSourceDeTeste();
    await ds.initialize();
    await ds
      .query(
        `INSERT INTO clients (id, name, cnpj) VALUES ($1, 'Cliente IT', 'it-flyer-ean') ON CONFLICT DO NOTHING`,
        [CLIENTE],
      )
      .catch(() => undefined);
  });
  afterEach(async () => {
    if (imagens.length)
      await ds.query(`DELETE FROM gallery_images WHERE id = ANY($1)`, [imagens.splice(0)]);
  });
  afterAll(async () => {
    await ds.query(`DELETE FROM clients WHERE id = $1`, [CLIENTE]).catch(() => undefined);
    await ds.destroy();
  });

  async function img(filename: string, meta: Record<string, unknown>) {
    const id = await inserirImagem(ds, filename, {
      title: filename,
      alternatives: [],
      warnings: [],
      ...meta,
    });
    imagens.push(id);
    return id;
  }

  function criar(
    opts: {
      lookup?: (eans: string[]) => Map<string, Partial<LookupOutcome>>;
      lento?: boolean;
      similares?: Record<string, Array<{ imageId: string; score: number }>>;
    } = {},
  ) {
    const matcher = {
      matchWithCandidates: jest.fn(async (products: Array<{ id: string }>) => ({
        result: {
          matches: products.map((p) => ({
            productId: p.id,
            imageId: 'por-nome',
            imageUrl: 'http://x/nome.png',
            score: 0.8,
            reasons: [],
            isClientPreferred: false,
          })),
          reviewCandidates: [],
          scanned: products.length,
          matched: products.length,
        },
        candidates: new Map(
          products.map((p) => [
            p.id,
            (opts.similares?.[p.id] ?? []).map((c) => ({
              imageId: c.imageId,
              url: `http://x/${c.imageId}.png`,
              thumbnailUrl: null,
              filename: `${c.imageId}.png`,
              folderName: null,
              score: c.score,
              reasons: [],
              isClientPreferred: false,
            })),
          ]),
        ),
      })),
    };
    const lookups = {
      resolve: jest.fn(async (eans: string[], _o: { kind: string }) => {
        if (opts.lento) await new Promise((r) => setTimeout(r, 300));
        const m = opts.lookup?.(eans) ?? new Map();
        const outcomes = new Map(
          eans.map((e) => [e, { ean: e, input: e, status: 'not_found', ...(m.get(e) ?? {}) }]),
        );
        return { outcomes, credits: 0, requests: 1, blocked: null, authError: null };
      }),
    };
    const photos = {
      importMany: jest.fn(async (items: Array<{ ean: string }>) => {
        const r = new Map();
        for (const { ean } of items) {
          const id = await img(`dotcompany-${ean}.png`, {
            ean,
            eanSource: 'dotcompany',
            eanVerifiedBy: 'exact',
          });
          r.set(ean, { ean, status: 'imported', galleryImageId: id });
        }
        return r;
      }),
    };
    const jobs = { criarJobDoEncarte: jest.fn(async () => ({ id: 'job' })) };
    const runner = { wake: jest.fn() };
    const config = {
      get: (k: string) =>
        k === 'EAN_FLYER_RESOLVE_TIMEOUT_MS' ? (opts.lento ? '100' : '5000') : undefined,
    };
    const svc = new FlyerEanResolutionService(
      ds,
      matcher as never,
      lookups as never,
      photos as never,
      jobs as never,
      runner as never,
      config as never,
    );
    return { svc, matcher, lookups, photos, jobs, runner };
  }

  it('galeria já tem foto do EAN: usa ela sem consultar a DotCompany', async () => {
    const id = await img('moca-antiga.png', { ean: NA_GALERIA, eanSource: 'off' });
    const { svc, lookups } = criar();
    const r = await svc.findImages([{ id: 'p1', name: 'Leite Moça', ean: NA_GALERIA }]);
    expect(lookups.resolve).not.toHaveBeenCalled();
    expect(r.matches).toEqual([
      expect.objectContaining({
        productId: 'p1',
        imageId: id,
        reasons: expect.arrayContaining(['EAN igual']),
      }),
    ]);
    expect(r.eanStatus).toEqual([{ productId: 'p1', ean: NA_GALERIA, status: 'gallery' }]);
  });

  it('cliente tem foto preferida do EAN: ela vai para o card e as demais viram alternativas', async () => {
    const dot = await img('dot.png', {
      ean: NA_GALERIA,
      eanSource: 'dotcompany',
      eanVerifiedBy: 'exact',
    });
    const pref = await img('pref.png', { ean: NA_GALERIA, eanSource: 'off' });
    await ds.query(`INSERT INTO client_preferred_images (client_id, image_id) VALUES ($1, $2)`, [
      CLIENTE,
      pref,
    ]);
    const { svc } = criar();
    const r = await svc.findImages([{ id: 'p1', name: 'Moça', ean: NA_GALERIA }], CLIENTE);
    expect(r.matches[0]).toMatchObject({ imageId: pref, isClientPreferred: true });
    expect(r.alternatives[0].options).toEqual([
      expect.objectContaining({ imageId: dot, origin: 'same-ean', source: 'dotcompany' }),
    ]);
  });

  it('sem preferida: foto de outra fonte vem antes da foto DotCompany', async () => {
    await img('dot.png', { ean: NA_GALERIA, eanSource: 'dotcompany', eanVerifiedBy: 'exact' });
    const nossa = await img('nossa.png', { ean: NA_GALERIA, eanSource: 'manual' });
    const { svc } = criar();
    const r = await svc.findImages([{ id: 'p1', name: 'Moça', ean: NA_GALERIA }]);
    expect(r.matches[0].imageId).toBe(nossa);
  });

  it('galeria sem o EAN: consulta a DotCompany (interativo), importa e usa a foto', async () => {
    const { svc, lookups, photos } = criar({
      lookup: () => new Map([[NOVO, { status: 'found', lookup: { ean: NOVO } as never }]]),
    });
    const r = await svc.findImages([{ id: 'p2', name: 'Oreo', ean: NOVO }], CLIENTE);
    expect(lookups.resolve).toHaveBeenCalledWith(
      [NOVO],
      expect.objectContaining({ kind: 'interactive' }),
    );
    expect(photos.importMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'interactive' }),
    );
    // A foto DotCompany não vira preferida do cliente: o importador nem recebe o cliente.
    expect(photos.importMany).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ clientIds: expect.anything(), signal: expect.anything() }),
    );
    expect(r.matches[0]).toMatchObject({
      productId: 'p2',
      reasons: expect.arrayContaining(['fonte: dotcompany']),
    });
    expect(r.eanStatus[0].status).toBe('dotcompany');
  });

  it('foto DotCompany + foto parecida na base = duas opções; a parecida não recebe EAN', async () => {
    const parecida = await img('oreo-da-base.png', { ean: null });
    const { svc } = criar({
      lookup: () => new Map([[NOVO, { status: 'found', lookup: { ean: NOVO } as never }]]),
      similares: {
        p2: [
          { imageId: parecida, score: 0.82 },
          { imageId: 'fraca', score: 0.3 },
        ],
      },
    });
    const r = await svc.findImages([{ id: 'p2', name: 'Oreo', ean: NOVO }]);
    expect(r.alternatives).toEqual([
      {
        productId: 'p2',
        options: [expect.objectContaining({ imageId: parecida, origin: 'similar' })],
      },
    ]);
    const [row] = await ds.query(
      `SELECT metadata->>'ean' AS ean FROM gallery_images WHERE id = $1`,
      [parecida],
    );
    expect(row.ean).toBeNull();
  });

  it('DotCompany não conhece: segue o casamento por nome', async () => {
    const { svc } = criar();
    const r = await svc.findImages([{ id: 'p3', name: 'Coisa', ean: INEXISTENTE }]);
    expect(r.matches[0]).toMatchObject({ productId: 'p3', imageId: 'por-nome' });
    expect(r.eanStatus[0]).toMatchObject({ status: 'not_found' });
  });

  it('EAN inválido e produto sem EAN: sem consulta, casamento por nome', async () => {
    const { svc, lookups } = criar();
    const r = await svc.findImages([
      { id: 'p4', name: 'X', ean: '7891000100104' },
      { id: 'p5', name: 'Y' },
    ]);
    expect(lookups.resolve).not.toHaveBeenCalled();
    expect(r.matches.map((m) => m.imageId)).toEqual(['por-nome', 'por-nome']);
    expect(r.eanStatus).toEqual([expect.objectContaining({ productId: 'p4', status: 'invalid' })]);
  });

  it('saldo zerado: sem erro, fotos pelo nome e status budget_blocked', async () => {
    const { svc } = criar({
      lookup: () =>
        new Map([
          [
            NOVO,
            { status: 'blocked', blockReason: 'no_credit', reason: 'Sem crédito na DotCompany.' },
          ],
        ]),
    });
    const r = await svc.findImages([{ id: 'p2', name: 'Oreo', ean: NOVO }]);
    expect(r.matches[0]).toMatchObject({ imageId: 'por-nome' });
    expect(r.eanStatus[0]).toMatchObject({
      status: 'budget_blocked',
      reason: 'Sem crédito na DotCompany.',
    });
  });

  it('prazo esgotado: responde no prazo e manda os EANs para um job do encarte', async () => {
    const { svc, jobs, runner } = criar({ lento: true });
    const t0 = Date.now();
    const r = await svc.findImages([{ id: 'p2', name: 'Oreo', ean: NOVO }], CLIENTE);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.pending).toEqual(['p2']);
    expect(r.eanStatus[0].status).toBe('pending');
    expect(jobs.criarJobDoEncarte).toHaveBeenCalledWith(
      [{ ean: NOVO, description: 'Oreo' }],
      CLIENTE,
    );
    expect(runner.wake).toHaveBeenCalled();
  });

  it('prazo estoura com consulta paga em voo: uma única chamada, cache gravado, job lê o cache', async () => {
    const ean = '7896000000019'; // válido (checksum conferido abaixo)
    await ds.query(`DELETE FROM dotcompany_lookups WHERE ean = $1`, [ean]);
    let chamadas = 0;
    const client = {
      lookupBatch: jest.fn(async (gtins: string[]) => {
        chamadas += 1;
        await new Promise((r) => setTimeout(r, 400)); // mais lenta que o prazo do encarte (100 ms)
        return {
          items: gtins.map((g) => ({
            gtin: g,
            encontrado: true,
            produto: { gtin: g, nome: 'PRODUTO LENTO', imagem_url: null },
          })),
          creditsCharged: null,
          rate: null,
          requestId: 'r',
          status: 200,
        };
      }),
    };
    const budget = {
      now: () => new Date('2026-10-10T12:00:00Z'),
      acquire: jest.fn(async () => ({
        ok: true,
        reason: null,
        retryAt: null,
        message: null,
        reserved: 4,
      })),
      release: jest.fn(async () => undefined),
      onNoCredit: jest.fn(),
      onRateLimited: jest.fn(),
    };
    const real = new DotcompanyLookupService(ds, client as never, budget as never);
    const base = criar({ lento: true });
    const svc = new FlyerEanResolutionService(
      ds,
      base.matcher as never,
      real,
      { importMany: jest.fn(async () => new Map()) } as never,
      base.jobs as never,
      base.runner as never,
      { get: (k: string) => (k === 'EAN_FLYER_RESOLVE_TIMEOUT_MS' ? '100' : undefined) } as never,
    );

    const t0 = Date.now();
    const r = await svc.findImages([{ id: 'p9', name: 'Lento', ean }], CLIENTE);
    expect(Date.now() - t0).toBeLessThan(380);
    expect(r.pending).toEqual(['p9']);
    expect(client.lookupBatch).toHaveBeenCalledTimes(1);

    // O runner do job `flyer` chega antes de a primeira consulta terminar: espera a mesma.
    const doJob = await real.resolve([ean], { kind: 'interactive' });
    expect(doJob.outcomes.get(ean)).toMatchObject({ status: 'found', cached: true });
    expect(chamadas).toBe(1);
    expect(budget.release).toHaveBeenCalledTimes(1);
    expect(budget.release).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 4, reserved: 4 }),
    );
    const [row] = await ds.query(`SELECT status FROM dotcompany_lookups WHERE ean = $1`, [ean]);
    expect(row.status).toBe('found');

    // E uma nova rodada do job, depois de tudo, sai do cache.
    await real.resolve([ean], { kind: 'batch' });
    expect(chamadas).toBe(1);
    await ds.query(`DELETE FROM dotcompany_lookups WHERE ean = $1`, [ean]);
  });
});
