import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { createTempE2eDb, TempE2eDb, urlWithDatabase } from './e2e-temp-db.testutil';
import {
  describeIfE2eDb,
  E2E_DB_ENV,
  E2E_DB_URL,
  E2E_TEST_ENTITIES,
  openE2eDb,
} from './e2e-test-db';

const SCENE_LOCK_KEY = 7_770_001;
const GALLERY_COLUMNS = [
  'metadata',
  'metadata_status',
  'metadata_error',
  'embedding',
  'metadata_embedding',
];

/** Cada cenário monta um banco `_e2e` temporário próprio, criado e apagado aqui; o `chroma_x_e2e` não é tocado. */
describeIfE2eDb('Montagem do banco de e2e (banco _e2e temporário)', () => {
  jest.setTimeout(120_000);
  const dbs: TempE2eDb[] = [];
  const opened: DataSource[] = [];

  const newDb = async () => {
    const db = await createTempE2eDb();
    dbs.push(db);
    return db;
  };
  const open = async (url: string) => {
    const dataSource = await openE2eDb(url);
    opened.push(dataSource);
    return dataSource;
  };
  const withClient = async <T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((dataSource) => dataSource.destroy()));
  });
  afterAll(async () => {
    for (const db of dbs) await db.drop();
  });

  const tableNames = async (dataSource: DataSource) =>
    (await dataSource.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).map(
      (row: { tablename: string }) => row.tablename,
    );

  it('banco recém-criado: tabelas das entidades, Galeria completa e unaccent, com quatro aberturas juntas', async () => {
    const db = await newDb();
    const sources = await Promise.all([1, 2, 3, 4].map(() => open(db.url)));
    const tables = await tableNames(sources[0]);
    for (const entity of E2E_TEST_ENTITIES) {
      expect(tables).toContain(sources[0].getMetadata(entity).tableName);
    }
    expect(tables).toEqual(
      expect.arrayContaining(['gallery_folders', 'client_preferred_images', 'fonts']),
    );
    const columns = await sources[0].query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'gallery_images'`,
    );
    expect(columns).toHaveLength(14);
    expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual(
      expect.arrayContaining(GALLERY_COLUMNS),
    );
    const [{ unaccent }] = await sources[0].query(`SELECT unaccent('Pão de Açúcar') AS unaccent`);
    expect(unaccent).toBe('Pao de Acucar');
  });

  it('abrir de novo um banco pronto não muda tabela, coluna, índice nem linha', async () => {
    const db = await newDb();
    const first = await open(db.url);
    await first.query(`INSERT INTO clients (name, cnpj) VALUES ('Cliente', 'cnpj-1')`);
    await first.query(
      `INSERT INTO gallery_images (filename, url, "mimeType", size) VALUES ('a.png', 'u', 'image/png', 1)`,
    );
    const snapshot = async (dataSource: DataSource) => ({
      columns: await dataSource.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' ORDER BY 1, 2`,
      ),
      indexes: await dataSource.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
      ),
      clients: await dataSource.query(`SELECT * FROM clients`),
      images: await dataSource.query(`SELECT * FROM gallery_images`),
    });
    const before = await snapshot(first);
    const second = await open(db.url);
    expect(await snapshot(second)).toEqual(before);
    expect(before.clients).toHaveLength(1);
    expect(before.images).toHaveLength(1);
  });

  it('as migrations não rodam: a tabela migrations não é criada nem ganha linha', async () => {
    const without = await newDb();
    expect(await tableNames(await open(without.url))).not.toContain('migrations');

    const withTable = await newDb();
    await withClient(withTable.url, (client) =>
      client.query(
        'CREATE TABLE migrations (id serial PRIMARY KEY, timestamp bigint, name varchar)',
      ),
    );
    const dataSource = await open(withTable.url);
    expect(await dataSource.query('SELECT * FROM migrations')).toEqual([]);
  });

  it('banco já usado com gallery_images de 9 colunas e 1 foto: completa as colunas e a foto fica', async () => {
    const db = await newDb();
    await withClient(db.url, async (client) => {
      await client.query(`CREATE TABLE gallery_folders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar NOT NULL, color varchar,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`);
      await client.query(`CREATE TABLE gallery_images (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), filename varchar NOT NULL, url varchar NOT NULL,
        "thumbnailUrl" varchar, "mimeType" varchar NOT NULL, size bigint NOT NULL,
        "folderId" uuid REFERENCES gallery_folders(id) ON DELETE SET NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`);
      await client.query(
        `INSERT INTO gallery_images (id, filename, url, "mimeType", size)
         VALUES ('11111111-1111-4111-8111-111111111111', 'velha.png', 'u', 'image/png', 1)`,
      );
    });
    const dataSource = await open(db.url);
    const columns = await dataSource.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'gallery_images'`,
    );
    expect(columns).toHaveLength(14);
    const images = await dataSource.query(
      `SELECT id, filename, metadata_status FROM gallery_images`,
    );
    expect(images).toEqual([
      { id: '11111111-1111-4111-8111-111111111111', filename: 'velha.png', metadata_status: null },
    ]);
  });

  it('extensões já existentes: a montagem segue sem erro e cria só o que faltava', async () => {
    const db = await newDb();
    await withClient(db.url, async (client) => {
      await client.query('CREATE EXTENSION unaccent');
      await client.query('CREATE EXTENSION pg_trgm');
    });
    const dataSource = await open(db.url);
    const extensions = await dataSource.query(`SELECT extname FROM pg_extension`);
    expect(extensions.map((row: { extname: string }) => row.extname)).toEqual(
      expect.arrayContaining(['unaccent', 'pg_trgm', 'vector', 'uuid-ossp']),
    );
  });

  it('trava ocupada por outra sessão (a das cenas): a montagem só começa depois que ela solta', async () => {
    const db = await newDb();
    await withClient(db.url, async (holder) => {
      await holder.query('SELECT pg_advisory_lock($1)', [SCENE_LOCK_KEY]);
      let settled = false;
      const opening = open(db.url).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled).toBe(false);
      const during = await holder.query(`SELECT to_regclass('clients') AS clients`);
      expect(during.rows[0].clients).toBeNull();
      await holder.query('SELECT pg_advisory_unlock($1)', [SCENE_LOCK_KEY]);
      const dataSource = await opening;
      expect(await tableNames(dataSource)).toContain('clients');
    });
  });

  it('banco _e2e que não existe: falha citando a variável e o banco', async () => {
    const missing = `chroma_x_inexistente_${Date.now()}_e2e`;
    const url = urlWithDatabase(E2E_DB_URL as string, missing);
    const failure = openE2eDb(url);
    await expect(failure).rejects.toThrow(new RegExp(`${E2E_DB_ENV}`));
    await expect(openE2eDb(url)).rejects.toThrow(new RegExp(missing));
  });

  it('Postgres fora do ar: falha citando a variável', async () => {
    const url = new URL(E2E_DB_URL as string);
    url.port = '1';
    await expect(openE2eDb(url.toString())).rejects.toThrow(new RegExp(E2E_DB_ENV));
  });
});
