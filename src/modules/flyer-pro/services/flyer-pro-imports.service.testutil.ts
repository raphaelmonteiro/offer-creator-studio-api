import type { DataSource, EntityManager } from 'typeorm';
import { IMPORT_ID } from '../testing/flyer-pro-imports.fixture';
import { FlyerProImportsService } from './flyer-pro-imports.service';
import { fakeDataSource } from '../testing/flyer-pro-fake-db.testutil';

/** Ajudantes dos unitários do passo da importação (só testes): o `manager` que registra os comandos e o serviço. */

export const DOCUMENT = 'd1';
export const OTHER_DOCUMENT = 'd2';
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

/** O serviço sobre um `DataSource` simulado que entrega o `manager` (a leitura roda numa transação `REPEATABLE READ`). */
export function makeImportsService(manager: object = makeImportsManager()) {
  const dataSource = fakeDataSource(manager);
  return { service: new FlyerProImportsService(dataSource as unknown as DataSource), dataSource };
}
