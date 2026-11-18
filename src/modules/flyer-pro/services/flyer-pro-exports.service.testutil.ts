import type { DataSource, EntityManager } from 'typeorm';
import type { CreateFlyerProExportDto } from '../dto/create-flyer-pro-export.dto';
import type { FlyerProExportEntry } from '../domain/flyer-pro.types';
import { ANA, DOCUMENT, exportEntry } from '../testing/flyer-pro-exports.fixture';
import { fakeDataSource } from '../testing/flyer-pro-fake-db.testutil';
import type { FlyerProExportRow } from '../views/flyer-pro-export.view';
import { FlyerProExportsService } from './flyer-pro-exports.service';

/** Ajudantes dos unitários do registro e do histórico das exportações (só testes): o `manager` e o serviço. */

export const OTHER_DOCUMENT = '8e4f1b30-6a2d-4c9b-b7d5-1f0a3c5e7d92';
export const BRUNO = 'c13e6b21-4d5f-4a8b-8e32-7f9a1b2c3d4e';

export interface ExportsManagerOptions {
  /** A revisão do encarte vivo; `null` simula o encarte inexistente ou excluído (a leitura do ORM não o traz). */
  revision?: number | null;
  /** A exportação que já estava gravada com esse `id`. */
  existing?: FlyerProExportRow;
  /** A que um registro simultâneo grava entre a primeira leitura e a inserção: o `INSERT` não grava e a releitura a traz. */
  racing?: FlyerProExportRow;
  /** Quantas exportações o histórico conta e a página que ele devolve. */
  total?: number;
  rows?: FlyerProExportRow[];
}

/**
 * O `manager` que simula o encarte e `flyer_pro_exports`: `findOne` devolve o encarte (ou nenhum), o `INSERT ... ON
 * CONFLICT DO NOTHING` grava a linha dos parâmetros ou não grava (o `id` já existia) e a leitura por `id` devolve a linha
 * que ficou. Nenhum comando de escrita fora do `INSERT` é aceito: o `manager` não tem `update`, `save` nem `delete`.
 */
export function makeExportsManager({
  revision = 41,
  existing,
  racing,
  total = 0,
  rows = [],
}: ExportsManagerOptions = {}) {
  let stored: FlyerProExportRow | undefined = existing;
  const manager = {
    findOne: jest.fn().mockResolvedValue(revision === null ? null : { id: DOCUMENT, revision }),
    query: jest.fn((sql: string, params: unknown[] = []): Promise<unknown> => {
      if (sql.startsWith('INSERT')) {
        if (racing) stored = racing;
        if (stored) return Promise.resolve([]);
        stored = insertedRow(params);
        return Promise.resolve([{ id: stored.id }]);
      }
      if (sql.startsWith('SELECT count')) return Promise.resolve([{ total }]);
      if (sql.includes('WHERE e."id" = $1')) return Promise.resolve(stored ? [stored] : []);
      return Promise.resolve(rows);
    }),
  };
  return manager as unknown as EntityManager & typeof manager;
}

/** A linha que o `INSERT` grava, montada dos parâmetros dele (na ordem das colunas do comando). */
function insertedRow(params: unknown[]): FlyerProExportRow {
  const [id, documentId, documentRevision, engineVersion, renderDigest, format] = params;
  const [options, fileName, fileSize, preflight, createdByUserId] = params.slice(6);
  return {
    id,
    documentId,
    documentRevision,
    engineVersion,
    renderDigest,
    format,
    options: JSON.parse(options as string),
    fileName,
    fileSize,
    preflight: preflight ? JSON.parse(preflight as string) : null,
    filePath: null,
    fileState: 'not_stored',
    createdByUserId,
    createdByName: createdByUserId === ANA ? 'Ana' : 'Bruno',
    createdAt: new Date('2026-11-14T18:02:11.000Z'),
  } as FlyerProExportRow;
}

/** Os comandos SQL enviados ao `manager`, na ordem. */
export const commandsOf = (manager: ReturnType<typeof makeExportsManager>) =>
  manager.query.mock.calls.map(([sql, params]) => ({ sql, params: params ?? [] }));

/** O comando `INSERT` enviado ao `manager`, se algum foi. */
export const insertOf = (manager: ReturnType<typeof makeExportsManager>) =>
  commandsOf(manager).find((command) => command.sql.startsWith('INSERT'));

/** O serviço sobre o `fakeDataSource`, que entrega o `manager` (com ou sem o nível de isolamento). */
export function makeExportsService(manager: object = makeExportsManager()) {
  const dataSource = fakeDataSource(manager);
  return { service: new FlyerProExportsService(dataSource as unknown as DataSource), dataSource };
}

/** O serviço sobre o `manager` simulado, com o registro chamado como o usuário dado (a Ana, por padrão). */
export function setupRegister(options: ExportsManagerOptions = {}) {
  const manager = makeExportsManager(options);
  const { service, dataSource } = makeExportsService(manager);
  /** O registro completo, tal como veio no corpo. */
  const registerEntry = (entry: object, userId = ANA, documentId = DOCUMENT) =>
    service.register(documentId, entry as CreateFlyerProExportDto, userId);
  /** O PDF do Piccin com o que o caso troca. */
  const register = (
    over: Partial<FlyerProExportEntry> | Record<string, unknown> = {},
    userId = ANA,
  ) => registerEntry({ ...exportEntry(), ...over }, userId);
  return { manager, dataSource, register, registerEntry, service };
}

/** O que o `rejects.toMatchObject` confere de um erro HTTP do módulo: o status e o `code`. */
export const rejection = (status: number, code: string) => ({
  status,
  response: expect.objectContaining({ code }),
});
