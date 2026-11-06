/**
 * Regras puras do GC dos arquivos da cena de template (change add-template-scene-persistence,
 * D-12 e PV-5). Tipos próprios: o `shared/` não importa o módulo da cena, que lê as tabelas por SQL.
 *
 * - Master e prévia ficam protegidas enquanto alguma das N versões `ready` mais recentes, uma
 *   versão aprovada ou a versão atual da cena as referenciar (versões `manual`/`restore` apontam
 *   para a master da origem). Toda imagem conta, inclusive a que o juiz reprovou (D-26): ela é `ready` e
 *   ocupa uma das N vagas (D-20), por isso a atual é protegida à parte (R22).
 * - `raw_output`, `mask` e `crop` expiram após o TTL; logo e elementos não expiram.
 * - Cena excluída há mais que a retenção perde todos os arquivos.
 */

export const SCENE_INTERMEDIATE_ROLES: readonly string[] = ['raw_output', 'mask', 'crop'];
export const SCENE_PROTECTABLE_ROLES: readonly string[] = ['master', 'preview'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SceneGcVersion {
  id: string;
  number: number;
  status: string;
  masterAssetId: string | null;
  previewAssetId: string | null;
  approvedAt: Date | null;
}

export interface SceneGcAsset {
  id: string;
  versionId: string;
  role: string;
  url: string;
  createdAt: Date;
  expiresAt: Date | null;
  purgedAt: Date | null;
}

export interface SceneGcConfig {
  /** `TEMPLATE_SCENE_MASTERS_KEPT`: versões `ready` mais recentes com master guardada. */
  mastersKept: number;
  /** `TEMPLATE_SCENE_ASSET_TTL_DAYS` em ms. */
  intermediateTtlMs: number;
  /** `TEMPLATE_SCENE_DELETED_RETENTION_DAYS` em ms. */
  deletedRetentionMs: number;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
};

export function sceneGcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SceneGcConfig {
  return {
    mastersKept: positiveInt(env.TEMPLATE_SCENE_MASTERS_KEPT, 5),
    intermediateTtlMs: positiveInt(env.TEMPLATE_SCENE_ASSET_TTL_DAYS, 7) * DAY_MS,
    deletedRetentionMs: positiveInt(env.TEMPLATE_SCENE_DELETED_RETENTION_DAYS, 30) * DAY_MS,
  };
}

/** Ids de master e prévia que o GC nunca apaga: as N `ready` mais novas, as aprovadas e a atual (D-20). */
export function selectProtectedSceneAssets(
  versions: readonly SceneGcVersion[],
  mastersKept: number,
  currentVersionId: string | null = null,
): Set<string> {
  const recent = versions
    .filter((version) => version.status === 'ready')
    .sort((a, b) => b.number - a.number)
    .slice(0, mastersKept);
  const approved = versions.filter((version) => version.approvedAt !== null);
  const current = versions.filter((version) => version.id === currentVersionId);
  const protectedIds = new Set<string>();
  for (const version of [...recent, ...approved, ...current]) {
    if (version.masterAssetId) protectedIds.add(version.masterAssetId);
    if (version.previewAssetId) protectedIds.add(version.previewAssetId);
  }
  return protectedIds;
}

export interface SceneGcInput {
  assets: readonly SceneGcAsset[];
  versions: readonly SceneGcVersion[];
  sceneDeletedAt: Date | null;
  /** Versão atual da cena: a master e a prévia dela nunca saem (D-20). */
  currentVersionId?: string | null;
  now: Date;
  config: SceneGcConfig;
}

export interface SceneGcSelection {
  /** Assets a apagar (marcar `purgedAt` e remover o arquivo). */
  purge: SceneGcAsset[];
  /** Assets protegidos que ainda tinham `expiresAt`: o GC limpa a marca. */
  clearExpiry: string[];
  /** Cena excluída além da retenção: apagar também a pasta inteira. */
  wholeScene: boolean;
}

/** O que o GC faz com os assets (ainda não apagados) de uma cena. */
export function selectSceneAssetsToPurge(input: SceneGcInput): SceneGcSelection {
  const { assets, versions, sceneDeletedAt, currentVersionId = null, now, config } = input;
  const live = assets.filter((asset) => asset.purgedAt === null);
  const deletedLongAgo =
    sceneDeletedAt !== null &&
    now.getTime() - sceneDeletedAt.getTime() >= config.deletedRetentionMs;
  if (deletedLongAgo) return { purge: live, clearExpiry: [], wholeScene: true };

  const protectedIds = selectProtectedSceneAssets(versions, config.mastersKept, currentVersionId);
  const purge: SceneGcAsset[] = [];
  const clearExpiry: string[] = [];
  for (const asset of live) {
    if (protectedIds.has(asset.id)) {
      if (asset.expiresAt !== null) clearExpiry.push(asset.id);
      continue;
    }
    const expired = asset.expiresAt !== null && asset.expiresAt.getTime() <= now.getTime();
    const intermediateExpired =
      SCENE_INTERMEDIATE_ROLES.includes(asset.role) &&
      now.getTime() - asset.createdAt.getTime() >= config.intermediateTtlMs;
    if (expired || intermediateExpired) purge.push(asset);
  }
  return { purge, clearExpiry, wholeScene: false };
}
