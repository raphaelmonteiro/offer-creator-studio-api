import {
  SceneGcAsset,
  SceneGcConfig,
  SceneGcVersion,
  sceneGcConfigFromEnv,
  selectProtectedSceneAssets,
  selectSceneAssetsToPurge,
} from './template-scenes-gc.rules';

const NOW = new Date('2026-11-04T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const CONFIG: SceneGcConfig = {
  mastersKept: 5,
  intermediateTtlMs: 7 * DAY_MS,
  deletedRetentionMs: 30 * DAY_MS,
};

/** Versão `ready` com master `m<n>` e prévia `p<n>` próprias. */
const version = (number: number, extra: Partial<SceneGcVersion> = {}): SceneGcVersion => ({
  id: `v${number}`,
  number,
  status: 'ready',
  masterAssetId: `m${number}`,
  previewAssetId: `p${number}`,
  approvedAt: null,
  ...extra,
});

const asset = (id: string, extra: Partial<SceneGcAsset> = {}): SceneGcAsset => ({
  id,
  versionId: 'v1',
  role: id.startsWith('p') ? 'preview' : 'master',
  url: `/uploads/template-scenes/s/v/${id}.png`,
  createdAt: daysAgo(1),
  expiresAt: null,
  purgedAt: null,
  ...extra,
});

const ids = (assets: SceneGcAsset[]) => assets.map((a) => a.id).sort();

describe('selectProtectedSceneAssets', () => {
  it('protege master e prévia das 5 versões ready mais recentes', () => {
    const versions = [1, 2, 3, 4, 5, 6].map((n) => version(n));
    const protectedIds = selectProtectedSceneAssets(versions, 5);
    expect([...protectedIds].sort()).toEqual(
      ['m2', 'm3', 'm4', 'm5', 'm6', 'p2', 'p3', 'p4', 'p5', 'p6'].sort(),
    );
  });

  it('só conta versões ready (falhas e canceladas não ocupam vaga)', () => {
    const versions = [
      version(1),
      version(2),
      version(3, { status: 'failed', masterAssetId: null, previewAssetId: null }),
      version(4, { status: 'cancelled', masterAssetId: null, previewAssetId: null }),
    ];
    expect(selectProtectedSceneAssets(versions, 2)).toEqual(new Set(['m1', 'p1', 'm2', 'p2']));
  });

  it('protege a versão aprovada mesmo fora das mais recentes', () => {
    const versions = [
      version(1, { approvedAt: daysAgo(10) }),
      ...[2, 3, 4, 5, 6, 7, 8].map((n) => version(n)),
    ];
    const protectedIds = selectProtectedSceneAssets(versions, 5);
    expect(protectedIds.has('m1')).toBe(true);
    expect(protectedIds.has('m2')).toBe(false);
    expect(protectedIds.has('m3')).toBe(false);
    expect(protectedIds.has('m4')).toBe(true);
  });

  it('master compartilhada: a versão antiga continua protegida pela manual que a usa', () => {
    const versions = [
      ...[2, 3, 4, 5, 6, 7].map((n) => version(n)),
      version(8, { masterAssetId: 'm2', previewAssetId: 'p2' }),
    ];
    const protectedIds = selectProtectedSceneAssets(versions, 5);
    expect(protectedIds.has('m2')).toBe(true);
    expect(protectedIds.has('p2')).toBe(true);
    expect(protectedIds.has('m3')).toBe(false);
  });

  it('protege a versão atual mesmo fora das mais recentes (D-20, R22)', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7].map((n) => version(n));
    const protectedIds = selectProtectedSceneAssets(versions, 5, 'v1');
    expect(protectedIds.has('m1')).toBe(true);
    expect(protectedIds.has('p1')).toBe(true);
    expect(protectedIds.has('m2')).toBe(false);
    expect(selectProtectedSceneAssets(versions, 5).has('m1')).toBe(false);
  });

  it('tentativas ocupam as vagas: a atual e a aprovada ficam além das 5', () => {
    const versions = [
      version(1),
      version(2, { approvedAt: daysAgo(3) }),
      ...[3, 4, 5, 6, 7].map((n) => version(n)),
    ];
    const protectedIds = selectProtectedSceneAssets(versions, 5, 'v1');
    expect([...protectedIds].sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7].flatMap((n) => [`m${n}`, `p${n}`]).sort(),
    );
  });

  it('cena sem versões não protege nada', () => {
    expect(selectProtectedSceneAssets([], 5).size).toBe(0);
  });
});

describe('selectSceneAssetsToPurge', () => {
  it('não apaga a master da versão atual, mesmo vencida e fora das vagas', () => {
    const versions = [1, 2, 3, 4, 5, 6, 7].map((n) => version(n));
    const assets = [asset('m1', { expiresAt: daysAgo(1) }), asset('m2', { expiresAt: daysAgo(1) })];
    const result = selectSceneAssetsToPurge({
      assets,
      versions,
      sceneDeletedAt: null,
      currentVersionId: 'v1',
      now: NOW,
      config: CONFIG,
    });
    expect(ids(result.purge)).toEqual(['m2']);
    expect(result.clearExpiry).toEqual(['m1']);
  });

  const six = [1, 2, 3, 4, 5, 6].map((n) => version(n));
  const sixAssets = (expiredIds: string[] = []) =>
    [1, 2, 3, 4, 5, 6].flatMap((n) => [
      asset(`m${n}`, { expiresAt: expiredIds.includes(`m${n}`) ? daysAgo(1) : null }),
      asset(`p${n}`, { expiresAt: expiredIds.includes(`p${n}`) ? daysAgo(1) : null }),
    ]);

  it('apaga a master e a prévia da sexta versão mais antiga (marcadas para expirar)', () => {
    const result = selectSceneAssetsToPurge({
      assets: sixAssets(['m1', 'p1']),
      versions: six,
      sceneDeletedAt: null,
      now: NOW,
      config: CONFIG,
    });
    expect(ids(result.purge)).toEqual(['m1', 'p1']);
    expect(result.wholeScene).toBe(false);
  });

  it('não apaga o que não está marcado para expirar nem o que ainda vale', () => {
    const result = selectSceneAssetsToPurge({
      assets: [asset('m1', { expiresAt: new Date(NOW.getTime() + DAY_MS) }), asset('m9')],
      versions: six,
      sceneDeletedAt: null,
      now: NOW,
      config: CONFIG,
    });
    expect(result.purge).toEqual([]);
  });

  it('nunca apaga o protegido, mesmo marcado: limpa a marca', () => {
    const result = selectSceneAssetsToPurge({
      assets: sixAssets(['m2', 'p6']),
      versions: six,
      sceneDeletedAt: null,
      now: NOW,
      config: CONFIG,
    });
    expect(result.purge).toEqual([]);
    expect(result.clearExpiry.sort()).toEqual(['m2', 'p6']);
  });

  it('ignora o que já foi apagado (purgedAt)', () => {
    const result = selectSceneAssetsToPurge({
      assets: [asset('m1', { expiresAt: daysAgo(1), purgedAt: daysAgo(1) })],
      versions: six,
      sceneDeletedAt: null,
      now: NOW,
      config: CONFIG,
    });
    expect(result.purge).toEqual([]);
  });

  it('intermediários expiram pelo TTL de 7 dias, mesmo sem expiresAt', () => {
    const result = selectSceneAssetsToPurge({
      assets: [
        asset('raw-old', { role: 'raw_output', createdAt: daysAgo(8) }),
        asset('mask-old', { role: 'mask', createdAt: daysAgo(7) }),
        asset('crop-new', { role: 'crop', createdAt: daysAgo(6) }),
        asset('logo-old', { role: 'logo', createdAt: daysAgo(40) }),
        asset('el-old', { role: 'element', createdAt: daysAgo(40) }),
      ],
      versions: six,
      sceneDeletedAt: null,
      now: NOW,
      config: CONFIG,
    });
    expect(ids(result.purge)).toEqual(['mask-old', 'raw-old']);
  });

  it('cena excluída há 31 dias: apaga tudo, inclusive logo e protegidos', () => {
    const result = selectSceneAssetsToPurge({
      assets: [...sixAssets(), asset('logo', { role: 'logo' })],
      versions: six,
      sceneDeletedAt: daysAgo(31),
      now: NOW,
      config: CONFIG,
    });
    expect(result.purge).toHaveLength(13);
    expect(result.wholeScene).toBe(true);
  });

  it('cena excluída há 29 dias ainda não perde os arquivos protegidos', () => {
    const result = selectSceneAssetsToPurge({
      assets: sixAssets(),
      versions: six,
      sceneDeletedAt: daysAgo(29),
      now: NOW,
      config: CONFIG,
    });
    expect(result.purge).toEqual([]);
    expect(result.wholeScene).toBe(false);
  });
});

describe('sceneGcConfigFromEnv', () => {
  it('usa os padrões 20, 7 e 30 (D-34: 20 imagens por cena)', () => {
    expect(sceneGcConfigFromEnv({})).toEqual({
      mastersKept: 20,
      intermediateTtlMs: 7 * DAY_MS,
      deletedRetentionMs: 30 * DAY_MS,
    });
  });

  it('lê as variáveis e ignora valor inválido', () => {
    expect(
      sceneGcConfigFromEnv({
        TEMPLATE_SCENE_MASTERS_KEPT: '3',
        TEMPLATE_SCENE_ASSET_TTL_DAYS: 'abc',
        TEMPLATE_SCENE_DELETED_RETENTION_DAYS: '0',
      } as NodeJS.ProcessEnv),
    ).toEqual({ mastersKept: 3, intermediateTtlMs: 7 * DAY_MS, deletedRetentionMs: 30 * DAY_MS });
  });
});
