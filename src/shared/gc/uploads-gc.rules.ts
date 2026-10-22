/**
 * Regras de seleção do GC de uploads (TDD ADR-05): função pura, separada do
 * I/O, para ser testável por contrato. Decide O QUE apagar; quem apaga é o
 * UploadsGcService.
 *
 * Regras:
 * - asset soft-deletado há mais de 7 dias → todos os seus arquivos;
 * - export com mais de 30 dias (soft-deletado ou não) → todos os seus arquivos;
 * - somente arquivos sob /uploads/animations/ entram na seleção (o GC nunca
 *   toca em uploads de outros domínios, mesmo que referenciados pelo asset).
 *
 * Comerciais (`selectCommercialsGarbage`, change video-formatos-personagem
 * tarefa 8.2) — retenção por tipo, só arquivos sob /uploads/commercials/:
 * - candidato de mascotização rejeitado (`kit_candidate` não escolhido, fora
 *   de rodada aberta e não referenciado por kit) com mais de 30 dias;
 * - tile substituído (`kit_tile` sem kit nem step que o referencie), passada
 *   a carência de 7 dias (o tile nasce antes do kit apontar para ele);
 * - versões antigas de entrega (`commercial_final`/`commercial_composed`):
 *   mantém as 3 mais recentes de cada tipo por projeto e as referenciadas
 *   pelo projeto (entrega corrente e última válida); as demais com mais de
 *   90 dias saem;
 * - arte `video_art` sem projeto que a use como fundo, com mais de 30 dias.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const SOFT_DELETED_RETENTION_MS = 7 * DAY_MS;
export const EXPORT_RETENTION_MS = 30 * DAY_MS;

/** Prefixo de arquivos elegíveis — o GC opera exclusivamente neste subdiretório. */
export const GC_URL_PREFIX = '/uploads/animations/';

export interface GcAssetCandidate {
  id: string;
  kind: string;
  createdAt: Date;
  deletedAt: Date | null;
  fileUrl: string | null;
  alphaUrl: string | null;
  posterUrl: string | null;
  thumbUrl: string | null;
}

export type GcReason = 'soft_deleted_expired' | 'export_expired' | CommercialsGcReason;

export interface GcSelection {
  assetId: string;
  reason: GcReason;
  /** Caminhos /uploads/animations/** a apagar (já filtrados pelo prefixo). */
  files: string[];
}

function collectFiles(asset: GcAssetCandidate): string[] {
  return [asset.fileUrl, asset.alphaUrl, asset.posterUrl, asset.thumbUrl].filter(
    (url): url is string => typeof url === 'string' && url.startsWith(GC_URL_PREFIX),
  );
}

/** Seleciona assets cujos arquivos devem ser apagados. Assets sem arquivo elegível são omitidos. */
export function selectGarbage(assets: GcAssetCandidate[], now: Date): GcSelection[] {
  const selections: GcSelection[] = [];
  for (const asset of assets) {
    let reason: GcReason | null = null;
    if (asset.deletedAt && now.getTime() - asset.deletedAt.getTime() > SOFT_DELETED_RETENTION_MS) {
      reason = 'soft_deleted_expired';
    } else if (
      asset.kind === 'export' &&
      now.getTime() - asset.createdAt.getTime() > EXPORT_RETENTION_MS
    ) {
      reason = 'export_expired';
    }
    if (!reason) continue;
    const files = collectFiles(asset);
    if (files.length === 0) continue;
    selections.push({ assetId: asset.id, reason, files });
  }
  return selections;
}

// ───────────────────── comerciais: retenção por tipo (8.2) ─────────────────────

/** Prefixo dos arquivos de comerciais elegíveis (mock-jobs e music-cache nunca são assets). */
export const COMMERCIALS_GC_URL_PREFIX = '/uploads/commercials/';

export const KIT_CANDIDATE_RETENTION_MS = 30 * DAY_MS;
/** Carência do tile sem referência: a aprovação grava o asset antes de apontar o kit para ele. */
export const SUPERSEDED_TILE_GRACE_MS = 7 * DAY_MS;
export const DELIVERY_RETENTION_MS = 90 * DAY_MS;
/** Entregas preservadas por projeto e por tipo (final e composição), além das referenciadas. */
export const DELIVERIES_KEPT_PER_PROJECT = 3;
export const VIDEO_ART_RETENTION_MS = 30 * DAY_MS;

/** Kinds que o GC de comerciais avalia. */
export const COMMERCIALS_GC_KINDS = [
  'kit_candidate',
  'kit_tile',
  'commercial_final',
  'commercial_composed',
  'video_art',
  'piece_still',
  'piece_background',
] as const;

/**
 * Entregas por projeto (ranking "3 mais recentes por tipo"): finais,
 * composições e o quadro parado da peça de ofertas (change
 * video-peca-configuravel, 6.6 — mesma regra do `commercial_composed`).
 */
export const COMMERCIALS_GC_DELIVERY_KINDS = [
  'commercial_final',
  'commercial_composed',
  'piece_still',
] as const;

/** Fundo enviado para uma peça de ofertas: fora de qualquer `mc_pieces.document`/`pieceSnapshot` há 30 dias → sai. */
export const PIECE_BACKGROUND_RETENTION_MS = 30 * DAY_MS;

export type CommercialsGcReason =
  | 'kit_candidate_rejected'
  | 'kit_tile_superseded'
  | 'delivery_superseded'
  | 'video_art_unreferenced'
  | 'piece_background_unreferenced';

export interface CommercialsGcAsset extends GcAssetCandidate {
  metadata: Record<string, unknown> | null;
}

/** Linha de `mc_character_kits` relevante para as referências. */
export interface CommercialsGcKit {
  id: string;
  candidateRoundId: string | null;
  identityAssetId: string | null;
  tileAssetId: string | null;
  cutoutAssetId: string | null;
  referenceAssetIds: string[] | null;
}

/** Linha de `mc_kit_candidates` relevante (escolha do usuário). */
export interface CommercialsGcCandidateRow {
  assetId: string | null;
  kitId: string;
  roundId: string;
  chosen: boolean;
}

/** Linha de `mc_projects` relevante (entregas e arte de fundo). */
export interface CommercialsGcProject {
  id: string;
  finalAssetId: string | null;
  lastDeliveryAssetId: string | null;
  backgroundArtAssetId: string | null;
}

/** Entrega (final/composição) de um projeto — TODAS as do projeto, para o ranking. */
export interface CommercialsGcDelivery {
  id: string;
  kind: string;
  projectId: string;
  createdAt: Date;
  version: number | null;
  /** Só `commercial_final`: composição que ela consumiu. */
  composedAssetId: string | null;
}

export interface CommercialsGcContext {
  kits: CommercialsGcKit[];
  candidates: CommercialsGcCandidateRow[];
  projects: CommercialsGcProject[];
  deliveries: CommercialsGcDelivery[];
  /** Assets referenciados por snapshots de steps (ex.: `inputSnapshot.tileAssetId` do talk). */
  stepReferencedAssetIds: string[];
  /**
   * Fundos (`piece_background`) cuja URL aparece em algum `mc_pieces.document`
   * ou `mc_projects.pieceSnapshot` (6.6). Ausente = contexto antigo, nada sai.
   */
  referencedPieceBackgroundIds?: string[];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function commercialsFiles(asset: GcAssetCandidate): string[] {
  return [asset.fileUrl, asset.alphaUrl, asset.posterUrl, asset.thumbUrl].filter(
    (url): url is string => typeof url === 'string' && url.startsWith(COMMERCIALS_GC_URL_PREFIX),
  );
}

/** Asset já recolhido numa varredura real anterior (arquivos apagados, linha soft-deletada). */
export function isGcCollected(asset: { metadata?: Record<string, unknown> | null }): boolean {
  const gc = asset.metadata?.gc as { collectedAt?: unknown } | undefined;
  return typeof gc?.collectedAt === 'string';
}

/**
 * Entregas preservadas: por projeto e por tipo, as `DELIVERIES_KEPT_PER_PROJECT`
 * mais recentes (data, depois versão), mais as referenciadas pelo projeto
 * (entrega corrente e última válida) e a composição de cada final preservada.
 */
export function keptDeliveryIds(
  deliveries: CommercialsGcDelivery[],
  projects: CommercialsGcProject[],
): Set<string> {
  const kept = new Set<string>();
  for (const p of projects) {
    if (p.finalAssetId) kept.add(p.finalAssetId);
    if (p.lastDeliveryAssetId) kept.add(p.lastDeliveryAssetId);
  }
  const groups = new Map<string, CommercialsGcDelivery[]>();
  for (const d of deliveries) {
    const key = `${d.projectId}|${d.kind}`;
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (b.version ?? 0) - (a.version ?? 0),
      )
      .slice(0, DELIVERIES_KEPT_PER_PROJECT)
      .forEach((d) => kept.add(d.id));
  }
  for (const d of deliveries) {
    if (d.kind === 'commercial_final' && kept.has(d.id) && d.composedAssetId) {
      kept.add(d.composedAssetId);
    }
  }
  return kept;
}

/**
 * Seleção do GC de comerciais (8.2) — função PURA: assets candidatos + as
 * referências lidas do banco → o que apagar e por quê. Na dúvida, preserva:
 * candidato da rodada aberta, qualquer asset apontado por kit, tile citado
 * por step, entrega corrente/última válida e arte usada por projeto.
 */
export function selectCommercialsGarbage(
  assets: CommercialsGcAsset[],
  ctx: CommercialsGcContext,
  now: Date,
): GcSelection[] {
  const kitRefs = new Set<string>();
  const openRounds = new Map<string, string>();
  for (const kit of ctx.kits) {
    for (const id of [kit.identityAssetId, kit.tileAssetId, kit.cutoutAssetId]) {
      if (id) kitRefs.add(id);
    }
    for (const id of kit.referenceAssetIds ?? []) kitRefs.add(id);
    if (kit.candidateRoundId) openRounds.set(kit.id, kit.candidateRoundId);
  }
  const chosen = new Set(
    ctx.candidates.filter((c) => c.chosen && c.assetId).map((c) => c.assetId as string),
  );
  const candidateRow = new Map(
    ctx.candidates.filter((c) => c.assetId).map((c) => [c.assetId as string, c]),
  );
  const stepRefs = new Set(ctx.stepReferencedAssetIds);
  const usedArt = new Set(
    ctx.projects.map((p) => p.backgroundArtAssetId).filter((id): id is string => !!id),
  );
  const keptDeliveries = keptDeliveryIds(ctx.deliveries, ctx.projects);
  const rankedDeliveries = new Set(ctx.deliveries.map((d) => d.id));
  const age = (asset: GcAssetCandidate) => now.getTime() - asset.createdAt.getTime();

  const selections: GcSelection[] = [];
  for (const asset of assets) {
    if (isGcCollected(asset)) continue;
    let reason: CommercialsGcReason | null = null;
    switch (asset.kind) {
      case 'kit_candidate': {
        if (age(asset) <= KIT_CANDIDATE_RETENTION_MS) break;
        if (kitRefs.has(asset.id) || chosen.has(asset.id)) break;
        const row = candidateRow.get(asset.id);
        const kitId = row?.kitId ?? str(asset.metadata?.kitId);
        const roundId = row?.roundId ?? str(asset.metadata?.roundId);
        if (kitId && roundId && openRounds.get(kitId) === roundId) break; // rodada aguardando escolha
        reason = 'kit_candidate_rejected';
        break;
      }
      case 'kit_tile': {
        if (age(asset) <= SUPERSEDED_TILE_GRACE_MS) break;
        if (kitRefs.has(asset.id) || stepRefs.has(asset.id)) break;
        reason = 'kit_tile_superseded';
        break;
      }
      case 'commercial_final':
      case 'commercial_composed':
      case 'piece_still': {
        if (age(asset) <= DELIVERY_RETENTION_MS) break;
        // fora do ranking do projeto (sem projectId, projeto não lido) = incerto → preserva
        if (!rankedDeliveries.has(asset.id) || keptDeliveries.has(asset.id)) break;
        reason = 'delivery_superseded';
        break;
      }
      case 'video_art': {
        if (age(asset) <= VIDEO_ART_RETENTION_MS) break;
        if (usedArt.has(asset.id)) break;
        reason = 'video_art_unreferenced';
        break;
      }
      case 'piece_background': {
        if (age(asset) <= PIECE_BACKGROUND_RETENTION_MS) break;
        // sem a consulta de referências (contexto antigo) = incerto → preserva
        if (!ctx.referencedPieceBackgroundIds) break;
        if (ctx.referencedPieceBackgroundIds.includes(asset.id)) break;
        reason = 'piece_background_unreferenced';
        break;
      }
      default:
        break;
    }
    if (!reason) continue;
    const files = commercialsFiles(asset);
    if (files.length === 0) continue;
    selections.push({ assetId: asset.id, reason, files });
  }
  return selections;
}
