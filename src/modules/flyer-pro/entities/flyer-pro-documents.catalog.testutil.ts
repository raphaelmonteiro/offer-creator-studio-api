/** O catálogo do Postgres das duas tabelas da M1, lido para os specs de banco (só testes). */

export const MIGRATION_TABLES = ['flyer_pro_documents', 'flyer_pro_items'];

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
 * As colunas, os índices e as restrições de `flyer_pro_documents` e `flyer_pro_items` num schema. O padrão de `id` do
 * encarte fica de fora: a migration usa `gen_random_uuid()` e o TypeORM `uuid_generate_v4()` (o mesmo caso das cenas),
 * e o `synchronize` não compara o padrão de chave gerada.
 */
export async function catalogOf(db: Query, schema: string): Promise<Catalog> {
  const columns = await db.query(
    `SELECT table_name || '.' || column_name || ': ' || data_type
            || coalesce('(' || character_maximum_length || ')', '')
            || CASE WHEN is_nullable = 'YES' THEN ' null' ELSE ' not null' END
            || CASE WHEN column_default IS NOT NULL AND NOT (table_name = 'flyer_pro_documents' AND column_name = 'id')
                    THEN ' default ' || column_default ELSE '' END AS definition
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = ANY($2)
      ORDER BY 1`,
    [schema, MIGRATION_TABLES],
  );
  const indexes = await db.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2)`,
    [schema, MIGRATION_TABLES],
  );
  const constraints = await db.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = ANY($2)`,
    [schema, MIGRATION_TABLES],
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
