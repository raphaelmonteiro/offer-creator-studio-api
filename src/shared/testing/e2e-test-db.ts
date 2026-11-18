import { DataSource } from 'typeorm';
import { FlyerBuilderV2Document } from '../../modules/flyer-builder-v2/entities/flyer-builder-v2-document.entity';
import { Client } from '../../modules/clients/entities/client.entity';
import { ClientContact } from '../../modules/clients/entities/client-contact.entity';
import { ClientStore } from '../../modules/clients/entities/client-store.entity';
import { FlyerProDocument } from '../../modules/flyer-pro/entities/flyer-pro-document.entity';
import { FlyerProItem } from '../../modules/flyer-pro/entities/flyer-pro-item.entity';
import { SCENE_TEST_ENTITIES } from '../../modules/template-scenes/testing/scene-test-db';
import { createGallerySchema } from './e2e-gallery-schema';

/**
 * Banco descartável do e2e do backend (change 05-add-backend-e2e-harness): a variável, a recusa do banco do
 * ambiente, o pulo sem a variável e a montagem do banco sob trava.
 *
 * AS MIGRATIONS NÃO RODAM aqui: a primeira não monta o schema do zero (é um `ALTER`). As tabelas nascem por
 * `synchronize` das entidades de `E2E_TEST_ENTITIES`, e a Galeria pelo SQL do app. Cada migration nova traz o seu
 * próprio spec, no molde de `template-scene-faces.migration.db.spec.ts` (schema temporário: sobe, sobe de novo,
 * desce).
 */
export const E2E_DB_ENV = 'FLYER_PRO_E2E_DB_URL';
export const E2E_DB_URL = process.env[E2E_DB_ENV];

/** `describe` normal com a variável definida; `describe.skip` sem ela (o gate nunca abre conexão com banco). */
export function selectDescribe(url: string | undefined): typeof describe {
  return url ? describe : describe.skip;
}

export const describeIfE2eDb: typeof describe = selectDescribe(E2E_DB_URL);

/** O nome do banco como veio na URL (sem `?…`), ou `''` se a URL não traz um. */
function rawDbNameOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${E2E_DB_ENV} não é uma URL de banco válida. Use postgres://usuario:senha@localhost:5434/chroma_x_e2e.`,
    );
  }
  return decodeURIComponent(parsed.pathname.replace(/^\//, ''));
}

/** Nome do banco da URL em minúsculas, sem parâmetros (`?sslmode=…`). */
export function e2eDbNameOf(url: string): string {
  return rawDbNameOf(url).toLowerCase();
}

/**
 * Confere o banco ANTES de abrir qualquer conexão: o `flyer_db` é sempre recusado e só passa banco cujo nome termina
 * em `_e2e` (D-3). O erro traz o nome recebido, nunca a senha. Devolve a URL já interpretada.
 */
export function assertE2eDbUrl(url: string | undefined): URL {
  if (!url) {
    throw new Error(
      `${E2E_DB_ENV} não definida. Passe a variável só na linha do comando, apontando para um banco _e2e (veja docs/environment.md).`,
    );
  }
  const received = rawDbNameOf(url) || '(nenhum)';
  const name = received.toLowerCase();
  if (name === 'flyer_db') {
    throw new Error(
      `O e2e nunca usa o flyer_db, que é o banco do ambiente (recebido: ${received}). Aponte ${E2E_DB_ENV} para um banco _e2e.`,
    );
  }
  if (!name.endsWith('_e2e')) {
    throw new Error(
      `O e2e só usa banco cujo nome termina em _e2e (recebido: ${received}). Aponte ${E2E_DB_ENV} para um banco descartável, como chroma_x_e2e.`,
    );
  }
  return new URL(url);
}

/**
 * As entidades que o `synchronize` monta. CADA TASK DE BACKEND ACRESCENTA AS SUAS aqui (e os dados dela à semente):
 * quem esquecer vê "relation does not exist" no próprio e2e. A Galeria não entra: as tabelas dela nascem pelo SQL do
 * app (`createGallerySchema`), e `GalleryImage` tem `synchronize: false`.
 */
export const E2E_TEST_ENTITIES = [
  ...SCENE_TEST_ENTITIES,
  Client,
  ClientContact,
  ClientStore,
  FlyerProDocument,
  FlyerProItem,
  FlyerBuilderV2Document,
];

/** A mesma trava do harness das cenas (A-5): os dois nunca montam o banco ao mesmo tempo. */
const SYNC_LOCK_KEY = 7_770_001;

/** Extensões do banco de e2e; `uuid-ossp` é a que o TypeORM usa nas chaves `uuid`. */
const EXTENSIONS = ['uuid-ossp', 'unaccent', 'pg_trgm', 'vector'];

async function createExtensions(dataSource: DataSource): Promise<void> {
  for (const extension of EXTENSIONS) {
    try {
      await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
    } catch (error) {
      throw new Error(
        `Não foi possível criar a extensão ${extension} no banco de e2e: ${(error as Error).message}`,
      );
    }
  }
}

/** Extensões, tabelas das entidades e Galeria, sob a trava: `CREATE … IF NOT EXISTS` de duas sessões pode falhar. */
async function assembleSchema(dataSource: DataSource): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1)', [SYNC_LOCK_KEY]);
    await createExtensions(dataSource);
    await dataSource.synchronize();
    await createGallerySchema(dataSource);
  } finally {
    await runner.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]).catch(() => undefined);
    await runner.release();
  }
}

async function connect(url: URL): Promise<DataSource> {
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  try {
    // Campos separados (e não `url`), como o harness das cenas. `installExtensions: false`: as extensões são
    // criadas sob a trava, e o TypeORM as criaria na conexão, fora dela.
    return await new DataSource({
      type: 'postgres',
      host: url.hostname,
      port: Number(url.port || 5432),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
      entities: E2E_TEST_ENTITIES,
      synchronize: false,
      installExtensions: false,
    }).initialize();
  } catch (error) {
    throw new Error(
      `Não foi possível abrir o banco de e2e "${database}" (${E2E_DB_ENV}): ${(error as Error).message}. ` +
        'Confira se o Postgres está no ar e se o banco existe (veja docs/environment.md).',
    );
  }
}

/**
 * Abre o banco de e2e e o monta (idempotente). A recusa do banco vem antes de qualquer conexão. Banco inexistente ou
 * Postgres fora do ar fazem a suíte falhar, e não pular: quem definiu a variável pediu e2e.
 */
export async function openE2eDb(url: string | undefined = E2E_DB_URL): Promise<DataSource> {
  const dataSource = await connect(assertE2eDbUrl(url));
  try {
    await assembleSchema(dataSource);
  } catch (error) {
    await dataSource.destroy();
    throw error;
  }
  return dataSource;
}
