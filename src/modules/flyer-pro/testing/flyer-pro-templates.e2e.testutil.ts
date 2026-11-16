import { DynamicModule } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { FlyerProTemplateEntry } from '../domain/flyer-pro.types';
import type { FlyerProFixtureScenes } from './flyer-pro-scene-fixture';

/** Helpers do e2e da N7 (só testes): a consulta ao banco compartilhado e o que ela devolve, por página. */

export type Entry = FlyerProTemplateEntry;

/** O envelope da N7 como o teste o lê: a lista, a paginação e o erro. */
export interface TemplatesBody {
  success: boolean;
  data: Entry[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  error?: { code: string };
}
export type Get = (url: string) => PromiseLike<{ status: number; body: TemplatesBody }>;

/** A lista inteira de uma consulta, percorrendo as páginas de 50 (o banco é compartilhado, A-3). */
export async function listAll(get: Get, query: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (let page = 1; ; page += 1) {
    const { status, body } = await get(`/flyer-pro/templates?${query}&page=${page}&limit=50`);
    if (status !== 200) throw new Error(`GET /flyer-pro/templates?${query}: ${status}`);
    entries.push(...body.data);
    if (page >= body.pagination.totalPages) return entries;
  }
}

/** A entrada de uma cena pelo `sceneId` (a rota, filtrada). */
export async function entryOf(get: Get, sceneId: string): Promise<Entry> {
  const { body } = await get(`/flyer-pro/templates?sceneId=${sceneId}`);
  return body.data[0];
}

/** Os ids da lista que pertencem à suíte, na ordem em que a rota devolveu. */
export const suiteIds = (entries: Entry[], suite: Iterable<string>): string[] => {
  const own = new Set(suite);
  return entries.map((entry) => entry.sceneId).filter((id) => own.has(id));
};

/** Contagem e último `updatedAt` das linhas da suíte nas três tabelas lidas, para provar que a rota não grava. */
export async function writeMarks(dataSource: DataSource, sceneIds: string[]) {
  const mark = async (sql: string) => (await dataSource.query(sql, [sceneIds]))[0];
  return {
    scenes: await mark(
      `SELECT count(*) AS n, max("updatedAt") AS at FROM template_scenes WHERE id = ANY($1::uuid[])`,
    ),
    faces: await mark(
      `SELECT count(*) AS n, max("updatedAt") AS at FROM template_scene_faces WHERE "sceneId" = ANY($1::uuid[])`,
    ),
    templates: await mark(
      `SELECT count(*) AS n, max("updatedAt") AS at FROM templates WHERE configuration->'source'->>'sceneId' = ANY($1)`,
    ),
  };
}

/** A linha de `templates` como gravada (a fonte do que a rota deve devolver). */
export async function templateRowOf(dataSource: DataSource, templateId: string) {
  const [row] = await dataSource.query(
    `SELECT id, "thumbnailUrl", configuration FROM templates WHERE id = $1`,
    [templateId],
  );
  return row;
}

/**
 * O `DataSource` do banco de e2e, visível dentro dos módulos importados (o harness o põe só na raiz do app). `get` roda
 * quando o app é montado, depois de o harness abrir o banco. Assim o spec carrega o `FlyerProModule` de verdade.
 */
export function e2eDataSourceModule(get: () => DataSource): DynamicModule {
  return {
    module: class E2eDataSourceModule {},
    global: true,
    providers: [{ provide: DataSource, useFactory: get }],
    exports: [DataSource],
  };
}

const OK = { usable: true, unusableReason: null, missingFaces: [] };
const MISSING = { usable: false, unusableReason: 'FACE_MISSING' };
const P27 = { format: '27x40', fold: 'simple', pageOptions: [1, 2, 3, 4], defaultPageCount: 1 };
const P54 = { format: '54x40', fold: 'double', pageOptions: [2, 4], defaultPageCount: 2 };

/** O que a lista diz de cada cena da fixture: campos da entrada e as chaves das faces prontas. */
export const ENTRY_CASES: Array<[keyof FlyerProFixtureScenes, object, string[]]> = [
  ['single1', { ...P27, ...OK }, ['single']],
  ['frontBack5', { ...P27, ...OK }, ['front', 'back']],
  ['tabloid3', { ...P54, ...OK }, ['outer', 'inner']],
  ['reserve', { ...P27, ...OK }, ['single']],
  ['frontOnly', { ...P27, ...MISSING, missingFaces: ['back'] }, ['front']],
  ['outerOnly', { ...P54, ...MISSING, missingFaces: ['inner'] }, ['outer']],
  ['frontDeleted', { ...P27, ...MISSING, missingFaces: ['front'], thumbnailUrl: null }, ['back']],
  [
    'single54',
    { ...P54, usable: false, unusableReason: 'LAYOUT_UNSUPPORTED', missingFaces: [] },
    ['single'],
  ],
];
