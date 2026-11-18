import type { DataSource, EntityManager } from 'typeorm';
import type { FlyerProItemsPatchDto } from '../dto/flyer-pro-items-patch.dto';
import type { FlyerProItem } from '../entities/flyer-pro-item.entity';
import { FlyerProItemsService } from './flyer-pro-items.service';
import { STAMP } from './flyer-pro-save.service.testutil';

/** Ajudantes dos unitários do ramo `items` (só testes): o `manager` que registra os comandos e a leitura dos itens. */

export const CONTEXT = { stamp: STAMP, userId: 'ana' };
export const DOCUMENT = 'd1';

export interface ItemsManagerOptions {
  /** O que `find` devolve: primeiro a leitura dos itens citados, depois a releitura do fim. */
  found?: FlyerProItem[][];
  /** Os ids que cada `DELETE` apaga, na ordem em que os comandos chegam. */
  deleted?: string[][];
  /** A contagem de itens do encarte depois de gravar. */
  total?: number;
  /** Os ids de importação deste encarte que a leitura das importações conhecidas devolve. */
  imports?: string[];
}

export function makeItemsManager({
  found = [],
  deleted = [],
  total = 3,
  imports = [],
}: ItemsManagerOptions = {}) {
  const finds = [...found];
  const deletes = [...deleted];
  const manager = {
    find: jest.fn(() => Promise.resolve(finds.shift() ?? [])),
    query: jest.fn((sql: string, _params?: unknown[]): Promise<unknown> => {
      if (sql.startsWith('DELETE')) {
        const ids = deletes.shift() ?? [];
        return Promise.resolve([ids.map((id) => ({ id })), ids.length]);
      }
      if (sql.startsWith('SELECT count')) return Promise.resolve([{ total }]);
      if (sql.includes('"flyer_pro_imports"'))
        return Promise.resolve(imports.map((id) => ({ id })));
      return Promise.resolve([]);
    }),
  };
  return manager as unknown as EntityManager & typeof manager;
}

export type ItemsManager = ReturnType<typeof makeItemsManager>;

/** Os comandos SQL, na ordem, como `{ sql, params }`. */
export const statementsOf = (manager: ItemsManager) =>
  manager.query.mock.calls.map(([sql, params]) => ({ sql, params: params ?? [] }));

/** Os comandos que começam por `verb` (`INSERT`, `UPDATE`, `DELETE`). */
export const statementsStartingWith = (manager: ItemsManager, verb: string) =>
  statementsOf(manager).filter((statement) => statement.sql.startsWith(verb));

/** Os registros que um `INSERT` ou `UPDATE` em lote gravou, lidos do jsonb do primeiro parâmetro. */
export const recordsOf = (statement: { params: unknown[] }): Array<Record<string, unknown>> =>
  JSON.parse(statement.params[0] as string);

/** O serviço sobre um `DataSource` simulado que entrega o `manager` (a leitura roda numa transação `REPEATABLE READ`). */
export function makeItemsService(manager: ItemsManager = makeItemsManager()) {
  const dataSource = {
    transaction: jest.fn((levelOrWork: unknown, maybeWork?: (m: unknown) => unknown) =>
      (typeof levelOrWork === 'string' ? maybeWork : (levelOrWork as (m: unknown) => unknown))(
        manager,
      ),
    ),
  };
  return { service: new FlyerProItemsService(dataSource as unknown as DataSource), dataSource };
}

export const run = (
  manager: ItemsManager,
  patch: Partial<FlyerProItemsPatchDto>,
  service = makeItemsService(manager).service,
) => service.apply(manager, DOCUMENT, patch as FlyerProItemsPatchDto, CONTEXT);
