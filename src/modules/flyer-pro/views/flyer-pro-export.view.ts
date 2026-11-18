import type { ExportFormat, ExportOptions, ExportPreflightCount } from '../domain/flyer-pro.types';

/**
 * A linha que o registro e o histórico leem: a exportação e o nome de quem exportou (`users.name`, nulo se o usuário não
 * existe mais). Vem de uma consulta crua, sem o transformador da entidade: `fileSize` (`bigint`) chega como texto.
 */
export interface FlyerProExportRow {
  id: string;
  documentId: string;
  documentRevision: number;
  engineVersion: number;
  renderDigest: string | null;
  format: ExportFormat;
  options: ExportOptions;
  fileName: string;
  fileSize: number | string | null;
  preflight: ExportPreflightCount | null;
  filePath: string | null;
  fileState: string;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date | string;
}

/**
 * Uma exportação do histórico (N9) e do registro (N8, que acrescenta `replayed`). Nunca traz `filePath`: nesta fase o
 * arquivo não é guardado (PU-50), e `hasFile` já sai para guardá-lo poder entrar depois sem mudar o contrato.
 */
export interface FlyerProExportView {
  id: string;
  documentId: string;
  format: ExportFormat;
  options: ExportOptions;
  documentRevision: number;
  engineVersion: number;
  renderDigest: string | null;
  fileName: string;
  fileSize: number | null;
  preflight: ExportPreflightCount | null;
  fileState: string;
  hasFile: boolean;
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export function toExportView(row: FlyerProExportRow): FlyerProExportView {
  return {
    id: row.id,
    documentId: row.documentId,
    format: row.format,
    options: row.options,
    documentRevision: row.documentRevision,
    engineVersion: row.engineVersion,
    renderDigest: row.renderDigest ?? null,
    fileName: row.fileName,
    fileSize: row.fileSize === null || row.fileSize === undefined ? null : Number(row.fileSize),
    preflight: row.preflight ?? null,
    fileState: row.fileState,
    hasFile: row.fileState === 'stored',
    createdByUserId: row.createdByUserId ?? null,
    createdByName: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
