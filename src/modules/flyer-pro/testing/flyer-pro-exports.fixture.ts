import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { ExportOptions, FlyerProExportEntry } from '../domain/flyer-pro.types';
import { FlyerProExport } from '../entities/flyer-pro-export.entity';
import type { FlyerProExportRow } from '../views/flyer-pro-export.view';

/**
 * Exportações para os testes do módulo `flyer-pro` (só testes): o corpo do N8 do cenário "PDF de todas as folhas do
 * Piccin" e as linhas gravadas direto no banco. É a única fábrica de exportação: o spec de schema (M4), o DTO, as
 * regras e o e2e partem dela. Remover o encarte fisicamente (`purgeDocumentsOf`) leva as exportações pela cascata.
 */

export type ExportSeed = Partial<Omit<FlyerProExport, 'document'>>;

export const EXPORT_ID = '5b0e2c1a-8d3f-4a4e-9c11-2f6a7d9e0b13';
/** O encarte "Ofertas Piccin - semana 47" e a Ana, que o exportou. */
export const DOCUMENT = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
export const ANA = 'b02d5a10-3c4e-4f7a-9d21-6e8f0a1b2c3d';

/** As opções do PDF das duas folhas do Piccin (54×40, 450 DPI); `over` troca ou acrescenta o que o caso pede. */
export const exportOptions = (over: Partial<ExportOptions> = {}): ExportOptions => ({
  preset: 'pdf-450-all',
  dpi: 450,
  unit: 'sheet',
  sheets: [1, 2],
  color: 'rgb',
  jpegQuality: 0.95,
  widthPx: 9567,
  heightPx: 7087,
  bleed: false,
  ...over,
});

/** O corpo do N8 do cenário "PDF de todas as folhas do Piccin"; `over` troca ou acrescenta o que o caso pede. */
export const exportEntry = (over: Partial<FlyerProExportEntry> = {}): FlyerProExportEntry => ({
  id: EXPORT_ID,
  format: 'pdf',
  options: exportOptions(),
  documentRevision: 41,
  engineVersion: 1,
  renderDigest: 'f3a91c07d2be4410',
  fileName: 'ofertas-piccin-semana-47-todas-450dpi-20261114-1502.pdf',
  fileSize: 31_457_280,
  preflight: { problems: 1, warnings: 3, infos: 1 },
  ...over,
});

/** O `png-72-sheet` coerente do cenário "PNG da folha escolhida a 72 DPI", sem `jpegQuality`, `fileSize` nem `preflight`. */
export const png72Entry = (over: Partial<FlyerProExportEntry> = {}): FlyerProExportEntry => {
  const { fileSize: _size, preflight: _preflight, ...base } = exportEntry();
  const { jpegQuality: _quality, ...options } = exportOptions();
  return {
    ...base,
    id: randomUUID(),
    format: 'png',
    options: {
      ...options,
      preset: 'png-72-sheet',
      dpi: 72,
      sheets: [1],
      widthPx: 765,
      heightPx: 1134,
    },
    fileName: 'feira-de-sabado-folha-1-72dpi-20261114-1502.png',
    ...over,
  };
};

/** A linha como a consulta crua a devolve: o PDF do Piccin feito pela Ana, no `DOCUMENT`, sem arquivo guardado. */
export const exportRow = (over: Partial<FlyerProExportRow> = {}): FlyerProExportRow => {
  const { id, format, documentRevision, engineVersion, renderDigest, fileName } = exportEntry();
  return {
    id,
    documentId: DOCUMENT,
    documentRevision,
    engineVersion,
    renderDigest,
    format,
    options: exportOptions(),
    fileName,
    fileSize: '31457280',
    preflight: { problems: 1, warnings: 3, infos: 1 },
    filePath: null,
    fileState: 'not_stored',
    createdByUserId: ANA,
    createdByName: 'Ana',
    createdAt: new Date('2026-11-14T18:02:11.000Z'),
    ...over,
  };
};

/** Grava uma exportação do encarte; o que o teste não informa leva o PDF do Piccin, sem autor. */
export async function insertExport(
  dataSource: DataSource,
  documentId: string,
  seed: ExportSeed = {},
): Promise<string> {
  const id = seed.id ?? randomUUID();
  const { id: _id, ...entry } = exportEntry();
  await dataSource.getRepository(FlyerProExport).insert({
    ...entry,
    ...seed,
    id,
    documentId,
  });
  return id;
}

/** As exportações do encarte como o banco as guarda, da mais antiga para a mais nova. */
export function exportsOf(
  dataSource: DataSource,
  documentId: string,
): Promise<Array<Record<string, unknown>>> {
  return dataSource.query(
    `SELECT * FROM flyer_pro_exports WHERE "documentId" = $1 ORDER BY "createdAt", "id"`,
    [documentId],
  );
}
