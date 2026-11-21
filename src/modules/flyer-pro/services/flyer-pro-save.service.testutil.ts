import type { DataSource, EntityManager } from 'typeorm';
import type { SaveFlyerProDocumentDto } from '../dto/save-flyer-pro-document.dto';
import { FlyerProDocument } from '../entities/flyer-pro-document.entity';
import { documentRow, STATUS } from './flyer-pro-documents.service.testutil';
import { FlyerProSaveService } from './flyer-pro-save.service';
import type { FlyerProImageLinkService } from './flyer-pro-image-link.service';
import type { FlyerProImportsService } from './flyer-pro-imports.service';
import type { FlyerProItemsService } from './flyer-pro-items.service';
import type { FlyerProJobsService } from './flyer-pro-jobs.service';
import type { FlyerProSetupService } from './flyer-pro-setup.service';
import type { FlyerProTemplateSnapshotService } from './flyer-pro-template-snapshot.service';
import { fakeDataSource } from '../testing/flyer-pro-fake-db.testutil';

/** Ajudantes dos unitários do salvar (só testes): o `manager` que registra os comandos e o corpo de um `PATCH`. */

/** O carimbo que o relógio do banco devolve (UTC, microssegundos). */
export const STAMP = '2026-11-14T14:33:10.004512Z';
/** O `updatedAt` que o `UPDATE ... RETURNING` devolve. */
export const SAVED_AT = new Date('2026-11-14T14:33:10.004Z');

/** O encarte do cenário da spec: revisão 37, gravado pela Ana na mutação `M0`. */
export const storedDocument = (over: Partial<FlyerProDocument> = {}): FlyerProDocument =>
  documentRow({
    id: 'd1',
    revision: 37,
    lastMutationId: 'M0',
    updatedByUserId: 'ana',
    updatedAt: new Date('2026-11-14T13:05:40.000Z'),
    ...over,
  });

/** Um `PATCH` válido na revisão 37; `over` troca ou acrescenta o que o caso pede. */
export const saveBody = (over: Record<string, unknown> = {}): SaveFlyerProDocumentDto =>
  ({
    mutationId: 'M1',
    expectedRevision: 37,
    schemaVersion: 1,
    engineVersion: 1,
    ...over,
  }) as SaveFlyerProDocumentDto;

/** O registro da foto na Galeria simulado: por padrão não falha em nenhum item (`linkWarnings: []`). */
export function makeLinkService() {
  const links = { register: jest.fn().mockResolvedValue([]) };
  return { links, service: links as unknown as FlyerProImageLinkService };
}

export type QueryCall = { sql: string; params: unknown[] };

/** O serviço sobre um `manager` simulado: a trava devolve `stored`, o relógio devolve `STAMP`, o `UPDATE` devolve `SAVED_AT`. */
export function makeSaveService(stored: FlyerProDocument = storedDocument()) {
  const manager = {
    findOne: jest.fn().mockResolvedValue(stored),
    query: jest.fn((sql: string, _params?: unknown[]): Promise<unknown> => {
      if (sql.includes('clock_timestamp')) return Promise.resolve([{ stamp: STAMP }]);
      if (sql.startsWith('UPDATE')) return Promise.resolve([[{ updatedAt: SAVED_AT }], 1]);
      return Promise.resolve([[], 0]);
    }),
  };
  const dataSource = fakeDataSource(manager);
  const setup = { apply: jest.fn().mockResolvedValue({}) };
  const snapshots = { statusOf: jest.fn().mockResolvedValue(STATUS) };
  const items = {
    apply: jest.fn().mockResolvedValue({ items: [], deletedItemIds: [], photoChoices: [] }),
    currentOf: jest.fn().mockResolvedValue([]),
  };
  const imports = { apply: jest.fn().mockResolvedValue({}) };
  const jobs = {
    requestAfterSave: jest.fn().mockResolvedValue({ started: false, job: null }),
    replayAfterSave: jest.fn().mockResolvedValue({ started: false, job: null }),
  };
  const link = makeLinkService();
  const service = new FlyerProSaveService(
    dataSource as unknown as DataSource,
    setup as unknown as FlyerProSetupService,
    snapshots as unknown as FlyerProTemplateSnapshotService,
    items as unknown as FlyerProItemsService,
    imports as unknown as FlyerProImportsService,
    jobs as unknown as FlyerProJobsService,
    link.service,
  );
  /** Os comandos SQL enviados ao `manager`, na ordem. */
  const calls = (): QueryCall[] =>
    manager.query.mock.calls.map(([sql, params]) => ({ sql, params: params ?? [] }));
  return {
    service,
    manager: manager as unknown as EntityManager & typeof manager,
    dataSource,
    setup,
    snapshots,
    items,
    imports,
    jobs,
    links: link.links,
    calls,
    updates: () => calls().filter((call) => call.sql.startsWith('UPDATE')),
  };
}

/** As colunas que um `UPDATE` grava, pelo nome, com o parâmetro de cada uma (jsonb como texto JSON). */
export function columnsSetBy(call: QueryCall): Record<string, unknown> {
  const sets = [...call.sql.matchAll(/"(\w+)" = \$(\d+)/g)].filter(([, , n]) => Number(n) >= 2);
  return Object.fromEntries(sets.map(([, name, n]) => [name, call.params[Number(n) - 1]]));
}
