import { DataSource } from 'typeorm';
import { User } from '../../auth/entities/user.entity';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';

/**
 * Banco descartável `chroma_x_e2e` (porta 5434), usado pelos specs de integração e pelo e2e da cena.
 * As migrations do projeto não montam o schema do zero (a primeira é `ALTER`), então o setup usa
 * entidades explícitas em `synchronize`, sob um lock de sessão para os workers do Jest não
 * sincronizarem ao mesmo tempo. Nunca aponta para o `flyer_db`.
 */
export const SCENE_DB_URL = process.env.TEMPLATE_SCENE_E2E_DB_URL;
export const describeIfSceneDb: typeof describe = SCENE_DB_URL ? describe : describe.skip;

export const SCENE_TEST_ENTITIES = [
  User,
  TemplateScene,
  TemplateSceneVersion,
  TemplateSceneAsset,
  TemplateSceneMessage,
];

const SYNC_LOCK_KEY = 7_770_001;

export async function openSceneTestDb(): Promise<DataSource> {
  if (!SCENE_DB_URL) throw new Error('TEMPLATE_SCENE_E2E_DB_URL não definida');
  if (/\/flyer_db(\?|$)/.test(SCENE_DB_URL)) throw new Error('O e2e nunca usa o flyer_db');
  const dataSource = await new DataSource({
    type: 'postgres',
    url: SCENE_DB_URL,
    entities: SCENE_TEST_ENTITIES,
    synchronize: false,
  }).initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1)', [SYNC_LOCK_KEY]);
    await dataSource.synchronize();
  } finally {
    await runner.query('SELECT pg_advisory_unlock($1)', [SYNC_LOCK_KEY]).catch(() => undefined);
    await runner.release();
  }
  return dataSource;
}

let userCounter = 0;

/** Usuário de teste com e-mail único (o `JwtAuthGuard` real lê `users`). */
export async function createTestUser(dataSource: DataSource, name = 'Autora Teste'): Promise<User> {
  userCounter += 1;
  const email = `scene-test-${Date.now()}-${process.pid}-${userCounter}@example.com`;
  return dataSource.manager.save(
    dataSource.manager.create(User, {
      email,
      password: 'senha-de-teste-123',
      name,
      emailVerified: true,
    }),
  );
}

/** Apaga as cenas (e, em cascata, versões, assets e mensagens) criadas pelo teste. */
export async function deleteTestScenes(dataSource: DataSource, sceneIds: string[]): Promise<void> {
  if (sceneIds.length === 0) return;
  await dataSource.query(`DELETE FROM template_scenes WHERE id = ANY($1::uuid[])`, [sceneIds]);
}
