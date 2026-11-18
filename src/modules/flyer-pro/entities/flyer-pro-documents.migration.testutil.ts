import { randomUUID } from 'crypto';
import type { QueryRunner } from 'typeorm';

/** Ajudantes dos specs de migration do encarte (M1, M2 e M4), que rodam num schema temporário (só testes). */

/** O que o `QueryRunner` já tipa: o comando e os parâmetros, e as linhas de volta. */
export type Exec = QueryRunner['query'];

/** As tabelas de outros módulos que as migrations do encarte não podem tocar. */
export const TABLES_OF_OTHERS = ['flyers', 'flyer_builder_v2_documents'];

/** `flyers` e `flyer_builder_v2_documents` mínimas com uma linha cada, para provar que a migration não as toca. */
export async function createOtherTables(exec: Exec): Promise<void> {
  await exec(`CREATE TABLE flyers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text)`);
  await exec(`CREATE INDEX "IDX_flyers_name" ON flyers (name)`);
  await exec(`INSERT INTO flyers (name) VALUES ('antigo')`);
  await exec(
    `CREATE TABLE flyer_builder_v2_documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`,
  );
  await exec(`INSERT INTO flyer_builder_v2_documents (title) VALUES ('v2')`);
}

/** O catálogo e as linhas das tabelas de outros módulos, para comparar antes e depois da migration. */
export async function othersOf(exec: Exec, schema: string) {
  return Promise.all(
    TABLES_OF_OTHERS.map(async (table) => ({
      columns: await exec(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY 1`,
        [schema, table],
      ),
      indexes: await exec(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
        [schema, table],
      ),
      rows: await exec(`SELECT * FROM ${table}`),
    })),
  );
}

/** Os nomes (primeira coluna) que a consulta devolve para o schema, ordenados. */
const namesIn = async (exec: Exec, schema: string, sql: string): Promise<string[]> =>
  (await exec(sql, [schema])).map((row: Record<string, string>) => Object.values(row)[0]).sort();

export const tablesIn = (exec: Exec, schema: string) =>
  namesIn(exec, schema, `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`);

export const indexesIn = (exec: Exec, schema: string) =>
  namesIn(exec, schema, `SELECT indexname FROM pg_indexes WHERE schemaname = $1`);

/** Um encarte só com o obrigatório (os padrões da M1 cobrem o resto); `extra` acrescenta colunas. */
export async function insertDocumentRow(
  exec: Exec,
  clientId: string,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const columns = ['id', 'name', 'clientId', 'sceneId', 'format', 'pageCount', 'templateSnapshot'];
  const values: unknown[] = [id, 'Ofertas', clientId, randomUUID(), '27x40', 1, '{"v":1}'];
  columns.push('engineVersion', ...Object.keys(extra));
  values.push(1, ...Object.values(extra));
  const marks = values.map((_, index) => `$${index + 1}`).join(', ');
  await exec(
    `INSERT INTO flyer_pro_documents (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${marks})`,
    values,
  );
}

/** Um item só com o obrigatório, na posição dada. */
export function insertItemRow(exec: Exec, documentId: string, position = 0): Promise<unknown> {
  return exec(
    `INSERT INTO flyer_pro_items (id, "documentId", position, name, price, unit) VALUES ($1, $2, $3, 'ABACATE', '{"kind":"simple","cents":699}', 'kg')`,
    [randomUUID(), documentId, position],
  );
}

/** Uma exportação só com o obrigatório (os padrões da M4 cobrem o resto); `extra` acrescenta colunas. */
export async function insertExportRow(
  exec: Exec,
  documentId: string,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const columns = ['id', 'documentId', 'documentRevision', 'engineVersion', 'format', 'fileName'];
  const values: unknown[] = [id, documentId, 3, 1, 'pdf', 'ofertas-piccin.pdf'];
  columns.push(...Object.keys(extra));
  values.push(...Object.values(extra));
  const marks = values.map((_, index) => `$${index + 1}`).join(', ');
  await exec(
    `INSERT INTO flyer_pro_exports (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${marks})`,
    values,
  );
}
