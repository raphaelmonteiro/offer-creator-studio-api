import {
  CommercialsGcAsset,
  CommercialsGcContext,
  CommercialsGcDelivery,
  DELIVERIES_KEPT_PER_PROJECT,
  keptDeliveryIds,
  selectCommercialsGarbage,
  selectGarbage,
} from './uploads-gc.rules';

/**
 * GC de /uploads/commercials/ (change video-formatos-personagem, tarefa 8.2):
 * retenção por tipo — função pura sobre os candidatos e as referências lidas
 * das tabelas mc_*. Na dúvida, preserva.
 */
const NOW = new Date('2026-10-12T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const asset = (overrides: Partial<CommercialsGcAsset> = {}): CommercialsGcAsset => ({
  id: 'a1',
  kind: 'kit_candidate',
  createdAt: daysAgo(40),
  deletedAt: null,
  fileUrl: '/uploads/commercials/kits/k1/candidate-1.png',
  alphaUrl: null,
  posterUrl: null,
  thumbUrl: null,
  metadata: { kitId: 'k1', roundId: 'r-old' },
  ...overrides,
});

const ctx = (overrides: Partial<CommercialsGcContext> = {}): CommercialsGcContext => ({
  kits: [],
  candidates: [],
  projects: [],
  deliveries: [],
  stepReferencedAssetIds: [],
  ...overrides,
});

const kit = (overrides: Partial<CommercialsGcContext['kits'][number]> = {}) => ({
  id: 'k1',
  candidateRoundId: null,
  identityAssetId: null,
  tileAssetId: null,
  cutoutAssetId: null,
  referenceAssetIds: [],
  ...overrides,
});

describe('selectCommercialsGarbage — candidatos de mascotização rejeitados (30 dias)', () => {
  it('não escolhido, rodada fechada, com mais de 30 dias → kit_candidate_rejected', () => {
    const result = selectCommercialsGarbage(
      [asset()],
      ctx({
        kits: [kit()],
        candidates: [{ assetId: 'a1', kitId: 'k1', roundId: 'r-old', chosen: false }],
      }),
      NOW,
    );
    expect(result).toEqual([
      {
        assetId: 'a1',
        reason: 'kit_candidate_rejected',
        files: ['/uploads/commercials/kits/k1/candidate-1.png'],
      },
    ]);
  });

  it('dentro de 30 dias, escolhido, identidade do kit ou da rodada ABERTA → preservado', () => {
    expect(selectCommercialsGarbage([asset({ createdAt: daysAgo(20) })], ctx(), NOW)).toEqual([]);
    expect(
      selectCommercialsGarbage(
        [asset()],
        ctx({ candidates: [{ assetId: 'a1', kitId: 'k1', roundId: 'r-old', chosen: true }] }),
        NOW,
      ),
    ).toEqual([]);
    expect(
      selectCommercialsGarbage([asset()], ctx({ kits: [kit({ identityAssetId: 'a1' })] }), NOW),
    ).toEqual([]);
    // rodada corrente aguardando escolha (pelo metadata do asset, sem linha na tabela)
    expect(
      selectCommercialsGarbage([asset()], ctx({ kits: [kit({ candidateRoundId: 'r-old' })] }), NOW),
    ).toEqual([]);
  });

  it('cópia do logo usado como está (sem linha de candidato) que deixou de ser a identidade → recolhida', () => {
    const logoCopy = asset({ id: 'logo-1', metadata: { kitId: 'k1', role: 'logo_as_is' } });
    expect(
      selectCommercialsGarbage([logoCopy], ctx({ kits: [kit({ identityAssetId: 'x' })] }), NOW),
    ).toMatchObject([{ assetId: 'logo-1', reason: 'kit_candidate_rejected' }]);
  });
});

describe('selectCommercialsGarbage — tiles substituídos', () => {
  const tile = (overrides: Partial<CommercialsGcAsset> = {}) =>
    asset({
      id: 't1',
      kind: 'kit_tile',
      createdAt: daysAgo(10),
      fileUrl: '/uploads/commercials/kits/k1/tile-1.png',
      metadata: { kitId: 'k1' },
      ...overrides,
    });

  it('sem kit nem step que o referencie, passada a carência de 7 dias → kit_tile_superseded (inclusive soft-deletado no descarte)', () => {
    expect(
      selectCommercialsGarbage(
        [tile({ deletedAt: daysAgo(9) })],
        ctx({ kits: [kit({ tileAssetId: 't2' })] }),
        NOW,
      ),
    ).toEqual([
      {
        assetId: 't1',
        reason: 'kit_tile_superseded',
        files: ['/uploads/commercials/kits/k1/tile-1.png'],
      },
    ]);
  });

  it('tile do kit, tile citado por snapshot de step ou dentro da carência → preservado', () => {
    expect(
      selectCommercialsGarbage([tile()], ctx({ kits: [kit({ tileAssetId: 't1' })] }), NOW),
    ).toEqual([]);
    expect(
      selectCommercialsGarbage([tile()], ctx({ stepReferencedAssetIds: ['t1'] }), NOW),
    ).toEqual([]);
    expect(selectCommercialsGarbage([tile({ createdAt: daysAgo(3) })], ctx(), NOW)).toEqual([]);
  });
});

describe('selectCommercialsGarbage — versões antigas de entrega (3 por projeto, 90 dias)', () => {
  const finals: CommercialsGcDelivery[] = [1, 2, 3, 4, 5].map((v) => ({
    id: `f${v}`,
    kind: 'commercial_final',
    projectId: 'p1',
    createdAt: daysAgo(200 - v * 20), // v5 é a mais recente
    version: v,
    composedAssetId: `c${v}`,
  }));
  const composed: CommercialsGcDelivery[] = [1, 2, 3, 4, 5].map((v) => ({
    id: `c${v}`,
    kind: 'commercial_composed',
    projectId: 'p1',
    createdAt: daysAgo(200 - v * 20),
    version: v,
    composedAssetId: null,
  }));
  const deliveryAsset = (d: CommercialsGcDelivery) =>
    asset({
      id: d.id,
      kind: d.kind,
      createdAt: d.createdAt,
      fileUrl: `/uploads/commercials/u1/p1/final/v${d.version}/${d.kind === 'commercial_final' ? 'final' : 'composed'}.mp4`,
      posterUrl:
        d.kind === 'commercial_final'
          ? `/uploads/commercials/u1/p1/final/v${d.version}/poster.jpg`
          : null,
      metadata: { projectId: 'p1', version: d.version },
    });

  it('keptDeliveryIds: as 3 mais recentes de cada tipo + referenciadas pelo projeto + composição das finais mantidas', () => {
    const kept = keptDeliveryIds(
      [...finals, ...composed],
      [{ id: 'p1', finalAssetId: 'f5', lastDeliveryAssetId: 'f1', backgroundArtAssetId: null }],
    );
    expect(DELIVERIES_KEPT_PER_PROJECT).toBe(3);
    expect([...kept].sort()).toEqual(['c1', 'c3', 'c4', 'c5', 'f1', 'f3', 'f4', 'f5'].sort());
  });

  it('fora das 3 mais recentes e com mais de 90 dias → delivery_superseded, com poster/thumb', () => {
    const all = [...finals, ...composed];
    const result = selectCommercialsGarbage(
      all.map(deliveryAsset),
      ctx({
        deliveries: all,
        projects: [
          { id: 'p1', finalAssetId: 'f5', lastDeliveryAssetId: null, backgroundArtAssetId: null },
        ],
      }),
      NOW,
    );
    // f1 (180 d) e f2 (160 d) e suas composições saem; v3 (140 d) é a 3ª mais recente
    expect(result.map((s) => s.assetId).sort()).toEqual(['c1', 'c2', 'f1', 'f2']);
    expect(result.find((s) => s.assetId === 'f1')).toEqual({
      assetId: 'f1',
      reason: 'delivery_superseded',
      files: [
        '/uploads/commercials/u1/p1/final/v1/final.mp4',
        '/uploads/commercials/u1/p1/final/v1/poster.jpg',
      ],
    });
  });

  it('entrega antiga referenciada (última válida) ou fora do ranking do projeto → preservada', () => {
    const all = [...finals, ...composed];
    const result = selectCommercialsGarbage(
      all.map(deliveryAsset),
      ctx({
        deliveries: all,
        projects: [
          { id: 'p1', finalAssetId: 'f5', lastDeliveryAssetId: 'f1', backgroundArtAssetId: null },
        ],
      }),
      NOW,
    );
    expect(result.map((s) => s.assetId).sort()).toEqual(['c2', 'f2']);
    // sem o ranking (projeto não lido): incerto → nada sai
    expect(selectCommercialsGarbage(all.map(deliveryAsset), ctx(), NOW)).toEqual([]);
  });

  it('com até 3 entregas, nenhuma sai mesmo com mais de 90 dias', () => {
    const few = finals.slice(0, 3);
    expect(selectCommercialsGarbage(few.map(deliveryAsset), ctx({ deliveries: few }), NOW)).toEqual(
      [],
    );
  });
});

describe('selectCommercialsGarbage — artes video_art sem projeto (30 dias)', () => {
  const art = (overrides: Partial<CommercialsGcAsset> = {}) =>
    asset({
      id: 'art1',
      kind: 'video_art',
      createdAt: daysAgo(31),
      fileUrl: '/uploads/commercials/art/u1/art-1.png',
      metadata: { aspectRatio: '4:5' },
      ...overrides,
    });

  it('sem projeto que a use como fundo, com mais de 30 dias → video_art_unreferenced', () => {
    expect(selectCommercialsGarbage([art()], ctx(), NOW)).toEqual([
      {
        assetId: 'art1',
        reason: 'video_art_unreferenced',
        files: ['/uploads/commercials/art/u1/art-1.png'],
      },
    ]);
  });

  it('usada por projeto ou recente → preservada', () => {
    expect(
      selectCommercialsGarbage(
        [art()],
        ctx({
          projects: [
            {
              id: 'p1',
              finalAssetId: null,
              lastDeliveryAssetId: null,
              backgroundArtAssetId: 'art1',
            },
          ],
        }),
        NOW,
      ),
    ).toEqual([]);
    expect(selectCommercialsGarbage([art({ createdAt: daysAgo(10) })], ctx(), NOW)).toEqual([]);
  });
});

describe('selectCommercialsGarbage — escopo e idempotência', () => {
  it('só arquivos sob /uploads/commercials/; asset sem arquivo elegível é omitido', () => {
    const outside = asset({
      fileUrl: '/uploads/gallery/x.png',
      thumbUrl: '/uploads/commercials/kits/k1/thumb.jpg',
    });
    expect(selectCommercialsGarbage([outside], ctx(), NOW)).toEqual([
      {
        assetId: 'a1',
        reason: 'kit_candidate_rejected',
        files: ['/uploads/commercials/kits/k1/thumb.jpg'],
      },
    ]);
    expect(selectCommercialsGarbage([asset({ fileUrl: '/uploads/x.png' })], ctx(), NOW)).toEqual(
      [],
    );
  });

  it('asset já recolhido (metadata.gc.collectedAt) não volta; kinds fora do escopo (clipes de cena) nunca saem', () => {
    expect(
      selectCommercialsGarbage(
        [asset({ metadata: { gc: { collectedAt: '2026-10-01T00:00:00Z' } } })],
        ctx(),
        NOW,
      ),
    ).toEqual([]);
    expect(
      selectCommercialsGarbage(
        [asset({ kind: 'scene_synced', createdAt: daysAgo(400) })],
        ctx(),
        NOW,
      ),
    ).toEqual([]);
  });

  it('a regra de animations continua ignorando /uploads/commercials/', () => {
    expect(
      selectGarbage(
        [asset({ kind: 'export', createdAt: daysAgo(100), deletedAt: daysAgo(100) })],
        NOW,
      ),
    ).toEqual([]);
  });
});
