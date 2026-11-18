import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { FlyerProImportEntry } from '../domain/flyer-pro-import.types';
import { FlyerProImport } from '../entities/flyer-pro-import.entity';

/**
 * Importações gravadas direto no banco, para os testes do módulo `flyer-pro` (só testes). É a única fábrica de linha de
 * importação: o spec de schema (M2) e o e2e das importações partem dela. Remover o encarte fisicamente
 * (`purgeDocumentsOf`) leva as importações pela cascata.
 */

export type ImportSeed = Partial<Omit<FlyerProImport, 'document'>>;

export const IMPORT_ID = '0b6f3d52-8e1a-4c27-9f40-6d2a7b1c5e83';

/** O `import` do cenário "Importar a lista do Piccin" (corpo do `PATCH`); `over` troca ou acrescenta o que o caso pede. */
export const importEntry = (over: Partial<FlyerProImportEntry> = {}): FlyerProImportEntry => ({
  id: IMPORT_ID,
  fileName: 'lista-piccin.csv',
  fileKind: 'csv',
  fileHash: '9f2c1a7b3d4e5f60',
  detectedFormat: 'csv',
  mode: 'append',
  rowCount: 5,
  acceptedCount: 4,
  rejected: [{ row: 7, reason: 'PRICE_MISSING', raw: 'FEIJAO CARIOCA' }],
  ...over,
});

/** Grava uma importação do encarte; o que o teste não informa leva a "lista-piccin.csv" de 5 linhas e 4 aceitas. */
export async function insertImport(
  dataSource: DataSource,
  documentId: string,
  seed: ImportSeed = {},
): Promise<string> {
  const id = seed.id ?? randomUUID();
  await dataSource.getRepository(FlyerProImport).insert({
    fileName: 'lista-piccin.csv',
    fileKind: 'csv',
    fileHash: '9f2c1a7b3d4e5f60',
    mode: 'append',
    rowCount: 5,
    acceptedCount: 4,
    rejected: [],
    ...seed,
    id,
    documentId,
  });
  return id;
}

/** As importações do encarte como o banco as guarda, da mais antiga para a mais nova. */
export function importsOf(
  dataSource: DataSource,
  documentId: string,
): Promise<Array<Record<string, unknown>>> {
  return dataSource.query(
    `SELECT * FROM flyer_pro_imports WHERE "documentId" = $1 ORDER BY "createdAt", "id"`,
    [documentId],
  );
}
