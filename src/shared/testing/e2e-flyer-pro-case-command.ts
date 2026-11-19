import { DataSource } from 'typeorm';
import { User } from '../../modules/auth/entities/user.entity';
import { Client } from '../../modules/clients/entities/client.entity';
import { FLYER_PRO_FREEZING_STEPS } from '../../modules/flyer-pro/domain/flyer-pro-steps';
import { FlyerProSceneReader } from '../../modules/flyer-pro/services/flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from '../../modules/flyer-pro/services/flyer-pro-template-snapshot.service';
import {
  insertDocumentWithItems,
  purgeDocumentsOf,
} from '../../modules/flyer-pro/testing/flyer-pro-documents.fixture';
import {
  CASE_NAME_PREFIX,
  CaseCommand,
  CreateCaseInput,
  parseCaseArgs,
} from './e2e-flyer-pro-case-args';
import { FIXED_IDENTITY } from './e2e-seed-identity';
import { assertE2eDbUrl, E2E_DB_ENV, openE2eDb } from './e2e-test-db';

export interface CreatedCase {
  id: string;
  name: string;
  revision: number;
}

export interface PurgedCases {
  deleted: number;
}

const SEED_HINT = 'Aplique a semente antes (npm run e2e:seed, veja docs/environment.md).';

/** Os clientes da semente fixa que existem no banco (o que falta não tem encarte: a FK `RESTRICT` o impede). */
async function seedClientIds(dataSource: DataSource): Promise<string[]> {
  const cnpjs = [FIXED_IDENTITY.clientWithLibrary.cnpj, FIXED_IDENTITY.clientLegacyFooter.cnpj];
  const rows = await dataSource.query(`SELECT id FROM clients WHERE cnpj = ANY($1::text[])`, [
    cnpjs,
  ]);
  return rows.map((row: { id: string }) => row.id);
}

/** O cliente, a cena e o usuário da semente fixa; o que falta manda aplicar a semente. */
async function seedRows(dataSource: DataSource) {
  const client = await dataSource
    .getRepository(Client)
    .findOneBy({ cnpj: FIXED_IDENTITY.clientWithLibrary.cnpj });
  const user = await dataSource.getRepository(User).findOneBy({ email: FIXED_IDENTITY.email });
  const [scene] = await dataSource.query(
    `SELECT id FROM template_scenes WHERE name = $1 AND "deletedAt" IS NULL`,
    [FIXED_IDENTITY.sceneFrontBack],
  );
  const missing = [
    [client, `o cliente "${FIXED_IDENTITY.clientWithLibrary.name}"`],
    [scene, `a cena "${FIXED_IDENTITY.sceneFrontBack}"`],
    [user, `o usuário ${FIXED_IDENTITY.email}`],
  ].find(([found]) => !found);
  if (missing) throw new Error(`A semente do e2e não tem ${missing[1]}. ${SEED_HINT}`);
  return {
    clientId: (client as Client).id,
    sceneId: scene.id as string,
    userId: (user as User).id,
  };
}

/**
 * Cria o encarte de um caso: no cliente e na cena 27×40 da semente fixa, com a cópia da arte que o N1 gravaria (a mesma
 * `FlyerProTemplateSnapshotService.build`), `revision: 0`, as versões recebidas e o usuário da semente como autor. Uma
 * etapa que congela as páginas (Montagem em diante) entra com `pagesFrozen`, como o N4 deixaria.
 */
async function createCase(dataSource: DataSource, input: CreateCaseInput): Promise<CreatedCase> {
  const { clientId, sceneId, userId } = await seedRows(dataSource);
  const snapshots = new FlyerProTemplateSnapshotService(dataSource, new FlyerProSceneReader());
  const name = `${CASE_NAME_PREFIX}${input.caseName}`;
  const items = input.items.map(({ cents, ...item }) => ({
    ...item,
    price: { kind: 'simple', cents },
  }));
  const { id } = await insertDocumentWithItems(
    dataSource,
    {
      clientId,
      sceneId,
      name,
      format: '27x40',
      pageCount: 1,
      templateSnapshot: await snapshots.build(sceneId),
      step: input.step,
      pagesFrozen: FLYER_PRO_FREEZING_STEPS.includes(input.step),
      schemaVersion: input.schemaVersion,
      engineVersion: input.engineVersion,
      createdByUserId: userId,
      updatedByUserId: userId,
    },
    items,
  );
  return { id, name, revision: 0 };
}

/** Apaga os encartes dos dois clientes da semente fixa (itens em cascata), sem tocar clientes, cenas nem outros clientes. */
async function purgeCases(dataSource: DataSource): Promise<PurgedCases> {
  const clientIds = await seedClientIds(dataSource);
  const [{ count }] = await dataSource.query(
    `SELECT count(*) FROM flyer_pro_documents WHERE "clientId" = ANY($1::uuid[])`,
    [clientIds],
  );
  await purgeDocumentsOf(dataSource, clientIds);
  return { deleted: Number(count) };
}

/**
 * O comando de teste do e2e de navegador que cria e apaga os encartes dos casos (change 17, U9.16; D-1 (b)). O banco é
 * conferido com a recusa do harness e os argumentos são lidos ANTES de abrir qualquer conexão. Veja `parseCaseArgs`.
 */
export async function runFlyerProCaseCommand(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreatedCase | PurgedCases> {
  const url = env[E2E_DB_ENV];
  assertE2eDbUrl(url);
  const command: CaseCommand = parseCaseArgs(argv);
  const dataSource = await openE2eDb(url);
  try {
    return command.action === 'create'
      ? await createCase(dataSource, command.input)
      : await purgeCases(dataSource);
  } finally {
    await dataSource.destroy();
  }
}
