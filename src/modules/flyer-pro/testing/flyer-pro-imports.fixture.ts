import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { FlyerProImport } from '../entities/flyer-pro-import.entity';

/**
 * Importações gravadas direto no banco, para os testes do módulo `flyer-pro` (só testes). É a única fábrica de linha de
 * importação: o spec de schema (M2) e o e2e das importações partem dela. Remover o encarte fisicamente
 * (`purgeDocumentsOf`) leva as importações pela cascata.
 */

export type ImportSeed = Partial<Omit<FlyerProImport, 'document'>>;

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
