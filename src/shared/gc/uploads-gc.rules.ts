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

export type GcReason = 'soft_deleted_expired' | 'export_expired';

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
