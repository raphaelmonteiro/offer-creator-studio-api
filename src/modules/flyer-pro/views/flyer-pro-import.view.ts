import type {
  FlyerProImportRejectedRow,
  ImportFileKind,
  ImportMode,
} from '../domain/flyer-pro-import.types';

/** A linha que o histórico lê: a importação e o nome de quem importou (`users.name`, nulo se o usuário não existe mais). */
export interface FlyerProImportRow {
  id: string;
  documentId: string;
  fileName: string;
  fileKind: ImportFileKind;
  fileHash: string;
  detectedFormat: string | null;
  mode: ImportMode;
  rowCount: number;
  acceptedCount: number;
  rejected: FlyerProImportRejectedRow[];
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: Date | string;
}

/** Uma importação do histórico (N13); o arquivo original não é guardado, e a contagem por motivo é do front. */
export interface FlyerProImportView {
  id: string;
  documentId: string;
  fileName: string;
  fileKind: ImportFileKind;
  fileHash: string;
  detectedFormat: string | null;
  mode: ImportMode;
  rowCount: number;
  acceptedCount: number;
  /** `rowCount` menos `acceptedCount`; pode passar de `rejected.length`, que guarda até 200 entradas. */
  rejectedCount: number;
  rejected: FlyerProImportRejectedRow[];
  createdByUserId: string | null;
  createdByName: string | null;
  createdAt: string;
}

export function toImportView(row: FlyerProImportRow): FlyerProImportView {
  return {
    id: row.id,
    documentId: row.documentId,
    fileName: row.fileName,
    fileKind: row.fileKind,
    fileHash: row.fileHash,
    detectedFormat: row.detectedFormat ?? null,
    mode: row.mode,
    rowCount: row.rowCount,
    acceptedCount: row.acceptedCount,
    rejectedCount: row.rowCount - row.acceptedCount,
    rejected: row.rejected ?? [],
    createdByUserId: row.createdByUserId ?? null,
    createdByName: row.createdByName ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
