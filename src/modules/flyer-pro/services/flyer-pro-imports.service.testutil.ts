import type { EntityManager } from 'typeorm';
import type { FlyerProImportEntry } from '../domain/flyer-pro-import.types';

/** Ajudantes dos unitários do passo da importação (só testes): o `manager` que registra os comandos e o registro do corpo. */

export const DOCUMENT = 'd1';
export const OTHER_DOCUMENT = 'd2';
export const IMPORT_ID = '0b6f3d52-8e1a-4c27-9f40-6d2a7b1c5e83';

/** O `import` do cenário "Importar a lista do Piccin"; `over` troca ou acrescenta o que o caso pede. */
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

export interface ImportsManagerOptions {
  /** O encarte dono do `id` quando ele já existe; sem isso, o `INSERT` grava. */
  existingOwner?: string;
}

/**
 * O `manager` que simula `flyer_pro_imports`: o `INSERT ... ON CONFLICT DO NOTHING` devolve a linha gravada ou nenhuma
 * (o `id` já existia) e a leitura do dono devolve `existingOwner`.
 */
export function makeImportsManager({ existingOwner }: ImportsManagerOptions = {}) {
  const manager = {
    query: jest.fn((sql: string, _params?: unknown[]): Promise<unknown> => {
      if (sql.startsWith('INSERT')) {
        return Promise.resolve(existingOwner ? [] : [{ id: IMPORT_ID }]);
      }
      if (sql.startsWith('SELECT "documentId"')) {
        return Promise.resolve(existingOwner ? [{ documentId: existingOwner }] : []);
      }
      return Promise.resolve([]);
    }),
  };
  return manager as unknown as EntityManager & typeof manager;
}

/** Os comandos SQL enviados ao `manager`, na ordem. */
export const commandsOf = (manager: ReturnType<typeof makeImportsManager>) =>
  manager.query.mock.calls.map(([sql, params]) => ({ sql, params: params ?? [] }));
