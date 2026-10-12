import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { UploadsGcService } from './uploads-gc.service';

/**
 * Dry-run do GC sobre FIXTURES reais em disco (tarefa 8.2): um diretório de
 * uploads temporário com arquivos de comerciais de cada tipo, o banco mockado
 * (assets candidatos + referências das tabelas mc_*). Por padrão nada é
 * apagado — só o log `would_delete`; com GC_DRY_RUN=false os arquivos
 * selecionados saem e o asset é soft-deletado/marcado.
 */
const NOW = new Date('2026-10-12T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

describe('UploadsGcService — varredura de /uploads/commercials/ (8.2)', () => {
  const originalDryRun = process.env.GC_DRY_RUN;
  let uploadsDir: string;
  let queries: Array<{ sql: string; params: unknown[] }>;
  let logSpy: jest.SpyInstance;
  let failCommercials: boolean;

  const commercialsAssets = [
    // candidato rejeitado (rodada antiga, não escolhido) — sai
    {
      id: 'cand-old',
      kind: 'kit_candidate',
      createdAt: daysAgo(45),
      deletedAt: null,
      fileUrl: '/uploads/commercials/kits/k1/candidate-old.png',
      alphaUrl: null,
      posterUrl: null,
      thumbUrl: null,
      metadata: { kitId: 'k1', roundId: 'r1' },
    },
    // candidato escolhido (identidade do kit) — fica
    {
      id: 'cand-chosen',
      kind: 'kit_candidate',
      createdAt: daysAgo(45),
      deletedAt: null,
      fileUrl: '/uploads/commercials/kits/k1/candidate-chosen.png',
      alphaUrl: null,
      posterUrl: null,
      thumbUrl: null,
      metadata: { kitId: 'k1', roundId: 'r1' },
    },
    // tile descartado (soft-deletado) — sai
    {
      id: 'tile-old',
      kind: 'kit_tile',
      createdAt: daysAgo(20),
      deletedAt: daysAgo(19),
      fileUrl: '/uploads/commercials/kits/k1/tile-old.png',
      alphaUrl: null,
      posterUrl: null,
      thumbUrl: null,
      metadata: { kitId: 'k1' },
    },
    // tile corrente do kit — fica
    {
      id: 'tile-cur',
      kind: 'kit_tile',
      createdAt: daysAgo(19),
      deletedAt: null,
      fileUrl: '/uploads/commercials/kits/k1/tile-cur.png',
      alphaUrl: null,
      posterUrl: null,
      thumbUrl: null,
      metadata: { kitId: 'k1' },
    },
    // arte sem projeto — sai; arte de projeto — fica
    {
      id: 'art-orphan',
      kind: 'video_art',
      createdAt: daysAgo(40),
      deletedAt: null,
      fileUrl: '/uploads/commercials/art/u1/orphan.png',
      alphaUrl: null,
      posterUrl: null,
      thumbUrl: null,
      metadata: {},
    },
    {
      id: 'art-used',
      kind: 'video_art',
      createdAt: daysAgo(40),
      deletedAt: null,
      fileUrl: '/uploads/commercials/art/u1/used.png',
      alphaUrl: null,
      posterUrl: null,
      thumbUrl: null,
      metadata: {},
    },
    // entrega v1 de 4 (a mais antiga, > 90 dias) — sai com o poster
    {
      id: 'f1',
      kind: 'commercial_final',
      createdAt: daysAgo(150),
      deletedAt: null,
      fileUrl: '/uploads/commercials/u1/p1/final/v1/final.mp4',
      alphaUrl: null,
      posterUrl: '/uploads/commercials/u1/p1/final/v1/poster.jpg',
      thumbUrl: null,
      metadata: { projectId: 'p1', version: 1 },
    },
  ];
  const deliveryRows = [1, 2, 3, 4].map((v) => ({
    id: `f${v}`,
    kind: 'commercial_final',
    projectId: 'p1',
    createdAt: daysAgo(150 - v * 10).toISOString(),
    version: String(v),
    composedAssetId: null,
  }));

  function dataSource() {
    return {
      getRepository: jest.fn(() => ({
        find: jest.fn((opts: { where: Array<{ kind?: unknown }> }) => {
          const commercials = opts.where.some((w) => w.kind === 'kit_candidate');
          if (commercials && failCommercials) return Promise.reject(new Error('relation mc_x'));
          return Promise.resolve(commercials ? commercialsAssets : []);
        }),
      })),
      query: jest.fn((sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('FROM mc_character_kits')) {
          return Promise.resolve([
            {
              id: 'k1',
              candidateRoundId: null,
              identityAssetId: 'cand-chosen',
              tileAssetId: 'tile-cur',
              cutoutAssetId: null,
              referenceAssetIds: [],
            },
          ]);
        }
        if (sql.includes('FROM mc_kit_candidates')) {
          return Promise.resolve([
            { assetId: 'cand-old', kitId: 'k1', roundId: 'r1', chosen: false },
            { assetId: 'cand-chosen', kitId: 'k1', roundId: 'r1', chosen: true },
          ]);
        }
        if (sql.includes('FROM mc_projects')) {
          return Promise.resolve([
            {
              id: 'p1',
              finalAssetId: 'f4',
              lastDeliveryAssetId: 'f3',
              backgroundArtAssetId: 'art-used',
            },
          ]);
        }
        if (sql.includes('FROM mc_steps')) return Promise.resolve([]);
        if (sql.trim().startsWith('SELECT') && sql.includes('FROM animation_assets')) {
          return Promise.resolve(deliveryRows);
        }
        return Promise.resolve([]);
      }),
    };
  }

  function service(): UploadsGcService {
    return new UploadsGcService(
      dataSource() as unknown as DataSource,
      {
        get: (key: string, fallback?: unknown) => (key === 'UPLOAD_DEST' ? uploadsDir : fallback),
      } as unknown as ConfigService,
    );
  }

  const fileOf = (url: string) => path.join(uploadsDir, url.replace(/^\/uploads\//, ''));
  const exists = (url: string) =>
    fs.access(fileOf(url)).then(
      () => true,
      () => false,
    );

  beforeEach(async () => {
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gc-commercials-'));
    for (const a of commercialsAssets) {
      for (const url of [a.fileUrl, a.posterUrl]) {
        if (!url) continue;
        await fs.mkdir(path.dirname(fileOf(url)), { recursive: true });
        await fs.writeFile(fileOf(url), 'x');
      }
    }
    queries = [];
    failCommercials = false;
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (originalDryRun === undefined) delete process.env.GC_DRY_RUN;
    else process.env.GC_DRY_RUN = originalDryRun;
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  it('dry-run por padrão: seleciona por tipo, registra would_delete e NÃO apaga nem marca nada', async () => {
    delete process.env.GC_DRY_RUN;
    const summary = await service().runOnce(NOW);
    expect(summary).toMatchObject({
      dryRun: true,
      scanned: commercialsAssets.length,
      selectedAssets: 4,
      deletedFiles: 5, // f1 tem vídeo + poster
      skippedFiles: 0,
      byReason: {
        kit_candidate_rejected: 1,
        kit_tile_superseded: 1,
        video_art_unreferenced: 1,
        delivery_superseded: 1,
      },
      commercials: { scanned: commercialsAssets.length, selectedAssets: 4 },
    });
    for (const a of commercialsAssets) expect(await exists(a.fileUrl)).toBe(true);
    expect(queries.some((q) => q.sql.includes('UPDATE animation_assets'))).toBe(false);
    const logged = logSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('"would_delete"'))
      .map((line) => JSON.parse(line) as { assetId: string; reason: string; file: string });
    expect(logged.map((l) => l.assetId).sort()).toEqual([
      'art-orphan',
      'cand-old',
      'f1',
      'f1',
      'tile-old',
    ]);
    expect(logged.find((l) => l.file.endsWith('poster.jpg'))).toMatchObject({
      reason: 'delivery_superseded',
    });
  });

  it('GC_DRY_RUN=false: apaga só os selecionados e soft-deleta/marca o asset (metadata.gc)', async () => {
    process.env.GC_DRY_RUN = 'false';
    const summary = await service().runOnce(NOW);
    expect(summary).toMatchObject({ dryRun: false, selectedAssets: 4, deletedFiles: 5 });
    const gone = ['cand-old', 'tile-old', 'art-orphan', 'f1'];
    for (const a of commercialsAssets) {
      expect(await exists(a.fileUrl)).toBe(!gone.includes(a.id));
    }
    expect(await exists('/uploads/commercials/u1/p1/final/v1/poster.jpg')).toBe(false);
    const updates = queries.filter((q) => q.sql.includes('UPDATE animation_assets'));
    expect(updates.map((q) => q.params[0]).sort()).toEqual([...gone].sort());
    expect(updates.find((q) => q.params[0] === 'f1')!.params[3]).toBe('delivery_superseded');
  });

  it('falha nas tabelas de comerciais não derruba a varredura de animations', async () => {
    failCommercials = true;
    const summary = await service().runOnce(NOW);
    expect(summary).toMatchObject({
      dryRun: true,
      scanned: 0,
      selectedAssets: 0,
      commercials: { scanned: 0, selectedAssets: 0 },
    });
  });
});
