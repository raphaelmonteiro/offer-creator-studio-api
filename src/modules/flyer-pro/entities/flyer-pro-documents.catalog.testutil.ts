/** O catálogo do Postgres das tabelas do encarte (M1 a M4), lido para os specs de banco (só testes). */

export const MIGRATION_TABLES = ['flyer_pro_documents', 'flyer_pro_items'];

/** A tabela e os dois índices que a M2 acrescenta; o spec da M1 continua contando só os seis dela. */
export const M2_TABLES = ['flyer_pro_imports'];

export const M2_INDEXES = ['IDX_flyer_pro_imports_document_hash', 'IDX_flyer_pro_items_import'];

/** As três tabelas depois da M2, para os specs que comparam o banco inteiro do encarte. */
export const ALL_TABLES = [...MIGRATION_TABLES, ...M2_TABLES];

/** A tabela e os dois índices que a M3 (job de enriquecimento) acrescenta. */
export const M3_TABLES = ['flyer_pro_jobs'];

export const M3_INDEXES = [
  'UQ_flyer_pro_jobs_document_active',
  'IDX_flyer_pro_jobs_document_created',
];

/** As quatro tabelas depois da M3, para o spec de schema que compara as entidades com M1 a M3. */
export const TABLES_AFTER_M3 = [...ALL_TABLES, ...M3_TABLES];

/** A tabela e o índice que a M4 acrescenta (as exportações). A M4 só depende da M1, por isso não entra em `ALL_TABLES`. */
export const M4_TABLES = ['flyer_pro_exports'];

export const M4_INDEXES = ['IDX_flyer_pro_exports_document_created'];

export const MIGRATION_INDEXES = [
  'IDX_flyer_pro_documents_list',
  'IDX_flyer_pro_documents_client',
  'UQ_flyer_pro_documents_creation_key',
  'IDX_flyer_pro_items_document_position',
  'IDX_flyer_pro_items_document_updated',
  'IDX_flyer_pro_items_gallery_image',
];

export interface Catalog {
  /** `tabela.coluna: tipo(tamanho) nulo/não nulo padrão`, ordenado. */
  columns: string[];
  /** Definição dos índices sem o nome do schema, por nome. */
  indexes: Record<string, string>;
  /** Chaves e restrições (`p`, `f`, `c`...) com a definição, por nome. */
  constraints: Record<string, string>;
}

/** O que `DataSource` e `QueryRunner` têm em comum. */
interface Query {
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, string>>>;
}

/** Tira o nome do schema que o Postgres põe na definição, para comparar schemas diferentes. */
const withoutSchema = (definition: string, schema: string): string =>
  definition.split(`${schema}.`).join('');

/**
 * As colunas, os índices e as restrições das tabelas dadas num schema (as duas da M1, por padrão; `ALL_TABLES` traz
 * também a da M2). O padrão de `id` do encarte e do job fica de fora: a migration usa `gen_random_uuid()` e o TypeORM
 * `uuid_generate_v4()` (o mesmo caso das cenas), e o `synchronize` não compara o padrão de chave gerada. O padrão `smallint`
 * `0` aparece como `'0'::smallint` no banco que o TypeORM monta e como `0` no da migration: o catálogo os trata como um.
 */
export async function catalogOf(
  db: Query,
  schema: string,
  tables: string[] = MIGRATION_TABLES,
): Promise<Catalog> {
  const columns = await db.query(
    `SELECT table_name || '.' || column_name || ': ' || data_type
            || coalesce('(' || character_maximum_length || ')', '')
            || CASE WHEN is_nullable = 'YES' THEN ' null' ELSE ' not null' END
            || CASE WHEN column_default IS NOT NULL
                         AND NOT (table_name IN ('flyer_pro_documents', 'flyer_pro_jobs') AND column_name = 'id')
                    THEN ' default ' || regexp_replace(column_default, '^''(\\d+)''::smallint$', '\\1')
                    ELSE '' END AS definition
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2)
      ORDER BY 1`,
    [schema, tables],
  );
  const indexes = await db.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2)`,
    [schema, tables],
  );
  const constraints = await db.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = ANY($2)`,
    [schema, tables],
  );
  const byName = (rows: Array<Record<string, string>>, name: string, value: string) =>
    Object.fromEntries(rows.map((row) => [row[name], withoutSchema(row[value], schema)]));
  return {
    columns: columns.map((row: { definition: string }) => row.definition),
    indexes: byName(indexes, 'indexname', 'indexdef'),
    constraints: byName(constraints, 'conname', 'definition'),
  };
}

/** `clients` mínima para a FK da M1 num schema temporário. */
export const MINIMAL_CLIENTS_SQL = `CREATE TABLE clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL)`;
