/** O registro de uma planilha importada (`flyer_pro_imports`, `a1-modelo-de-dados.html#s4` e `#s7-5`). */

export const IMPORT_FILE_KINDS = ['csv', 'xlsx', 'xls'] as const;
export type ImportFileKind = (typeof IMPORT_FILE_KINDS)[number];

/** `append` acrescenta à lista; `replace` é "Substituir a lista" (descongela as páginas). */
export const IMPORT_MODES = ['append', 'replace'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** Os motivos de uma linha recusada; a lista é fechada. */
export const IMPORT_REJECT_REASONS = [
  'NAME_MISSING',
  'PRICE_MISSING',
  'PRICE_INVALID',
  'PRICE_ABOVE_MAX',
  'DUPLICATE',
] as const;
export type ImportRejectReason = (typeof IMPORT_REJECT_REASONS)[number];

/** Uma linha recusada: o número dela na planilha, o motivo e o trecho como veio (até 200 caracteres). */
export interface FlyerProImportRejectedRow {
  row: number;
  reason: ImportRejectReason;
  raw: string;
}

/** Os campos do registro como o corpo do `PATCH` os traz (`import`). */
export interface FlyerProImportEntry {
  id: string;
  fileName: string;
  fileKind: ImportFileKind;
  fileHash: string;
  detectedFormat?: string;
  mode: ImportMode;
  rowCount: number;
  acceptedCount: number;
  rejected: FlyerProImportRejectedRow[];
}
