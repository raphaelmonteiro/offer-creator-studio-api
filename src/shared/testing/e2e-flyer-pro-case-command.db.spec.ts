import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { FlyerProDocument } from '../../modules/flyer-pro/entities/flyer-pro-document.entity';
import { FlyerProItem } from '../../modules/flyer-pro/entities/flyer-pro-item.entity';
import { FlyerProSceneReader } from '../../modules/flyer-pro/services/flyer-pro-scene.reader';
import { FlyerProTemplateSnapshotService } from '../../modules/flyer-pro/services/flyer-pro-template-snapshot.service';
import {
  insertClient,
  insertDocument,
  insertDocumentWithItems,
} from '../../modules/flyer-pro/testing/flyer-pro-documents.fixture';
import { CreatedCase, PurgedCases, runFlyerProCaseCommand } from './e2e-flyer-pro-case-command';
import { runE2eSeedCommand } from './e2e-seed-command';
import { FIXED_IDENTITY } from './e2e-seed-identity';
import { createTempE2eDb, TempE2eDb, urlWithDatabase } from './e2e-temp-db.testutil';
import { describeIfE2eDb, E2E_DB_ENV, E2E_DB_URL, openE2eDb } from './e2e-test-db';

const CDN = 'http://localhost:3102/uploads';
const VERSIONS = ['--schema-version', '1', '--engine-version', '3'];

/** O comando de teste dos encartes dos casos (change 17, U9.16), num banco `_e2e` temporário, criado e apagado aqui. */
describeIfE2eDb('Comando que cria e apaga os encartes dos casos do e2e de navegador', () => {
  jest.setTimeout(180_000);
  let temp: TempE2eDb;
  let uploadsDir: string;
  let dataSource: DataSource;
  const env = () => ({ [E2E_DB_ENV]: temp.url });
  const create = (...args: string[]) =>
    runFlyerProCaseCommand(['create', ...args], env()) as Promise<CreatedCase>;
  const purge = () => runFlyerProCaseCommand(['purge'], env()) as Promise<PurgedCases>;
  const documents = () => dataSource.getRepository(FlyerProDocument);
  const clientIdOf = async (cnpj: string) =>
    (await dataSource.query(`SELECT id FROM clients WHERE cnpj = $1`, [cnpj]))[0].id as string;
  const count = async (table: string) =>
    Number((await dataSource.query(`SELECT count(*) FROM ${table}`))[0].count);

  beforeAll(async () => {
    temp = await createTempE2eDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-flyer-pro-case-'));
    dataSource = await openE2eDb(temp.url);
  });
  afterAll(async () => {
    await dataSource?.destroy();
    await temp?.drop();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  it('semente ausente: create manda aplicar a semente sem gravar; purge apaga 0', async () => {
    await expect(create('--case', 'sem semente', ...VERSIONS)).rejects.toThrow(
      /A semente do e2e não tem o cliente .*npm run e2e:seed/,
    );
    expect(await count('flyer_pro_documents')).toBe(0);
    expect(await purge()).toEqual({ deleted: 0 });
    await runE2eSeedCommand({ ...env(), UPLOAD_DEST: uploadsDir, CDN_URL: CDN });
  });

  it('criar: o encarte tem a arte da cena, a etapa, as versões, o autor e os itens padrão', async () => {
    const created = await create('--case', 'Estrutura', ...VERSIONS, '--step', 'structure');
    expect(created).toEqual({
      id: expect.any(String),
      name: 'Ofertas Piccin semana 47 · Estrutura',
      revision: 0,
    });
    const doc = await documents().findOneByOrFail({ id: created.id });
    const sceneId = (
      await dataSource.query(`SELECT id FROM template_scenes WHERE name = $1`, [
        FIXED_IDENTITY.sceneFrontBack,
      ])
    )[0].id;
    const expected = await new FlyerProTemplateSnapshotService(
      dataSource,
      new FlyerProSceneReader(),
    ).build(sceneId);
    expect(expected.faces.length).toBeGreaterThan(0);
    expect(doc.templateSnapshot.faces).toEqual(expected.faces);
    expect(doc).toMatchObject({
      name: created.name,
      clientId: await clientIdOf(FIXED_IDENTITY.clientWithLibrary.cnpj),
      sceneId,
      format: '27x40',
      pageCount: 1,
      step: 'structure',
      pagesFrozen: false,
      schemaVersion: 1,
      engineVersion: 3,
      revision: 0,
      ui: {},
      renderDigest: null,
      layoutDigest: null,
      deletedAt: null,
    });
    const [user] = await dataSource.query(`SELECT id FROM users WHERE email = $1`, [
      FIXED_IDENTITY.email,
    ]);
    expect(doc.createdByUserId).toBe(user.id);
    expect(doc.updatedByUserId).toBe(user.id);
    const items = await dataSource
      .getRepository(FlyerProItem)
      .find({ where: { documentId: created.id }, order: { position: 'ASC' } });
    expect(items.map(({ name, unit, price }) => [name, unit, price])).toEqual([
      ['ABACATE', 'kg', { kind: 'simple', cents: 699 }],
      ['CERVEJA PILSEN GARRAFA 600ML', 'cada', { kind: 'simple', cents: 449 }],
      ['ARROZ 5 kg', 'pct', { kind: 'simple', cents: 2490 }],
    ]);
  });

  it('criar com itens pedidos e etapa que congela as páginas; dois casos, dois ids', async () => {
    const items = JSON.stringify([{ name: 'LEITE', unit: 'bdj', cents: 549 }]);
    const first = await create(
      '--case',
      'Montagem',
      ...VERSIONS,
      '--step',
      'assembly',
      '--items',
      items,
    );
    const second = await create('--case', 'Montagem', ...VERSIONS);
    expect(second.id).not.toBe(first.id);
    expect(await documents().findOneByOrFail({ id: first.id })).toMatchObject({
      step: 'assembly',
      pagesFrozen: true,
    });
    const rows = await dataSource
      .getRepository(FlyerProItem)
      .find({ where: { documentId: first.id } });
    expect(rows.map((item) => [item.name, item.unit, item.price])).toEqual([
      ['LEITE', 'bdj', { kind: 'simple', cents: 549 }],
    ]);
    expect(await documents().findOneByOrFail({ id: second.id })).toMatchObject({
      step: 'products',
      pagesFrozen: false,
    });
  });

  it('itens com categoria: a pedida entra com a origem import; sem ela, categoria e origem nulas', async () => {
    const items = JSON.stringify([
      { name: 'ABACATE', unit: 'kg', cents: 699, category: 'Hortifruti' },
      { name: 'QUEIJO MINAS', unit: 'kg', cents: 3990, category: 'Frios e Laticinios' },
      { name: 'VINHO TINTO SECO 750ML', unit: 'cada', cents: 4990 },
      { name: 'CERVEJA', unit: 'cada', cents: 449, category: null },
    ]);
    const created = await create('--case', 'categorias', ...VERSIONS, '--items', items);
    const rows = await dataSource
      .getRepository(FlyerProItem)
      .find({ where: { documentId: created.id }, order: { position: 'ASC' } });
    expect(rows.map((item) => [item.name, item.category, item.categorySource])).toEqual([
      ['ABACATE', 'Hortifruti', 'import'],
      ['QUEIJO MINAS', 'Frios e Laticinios', 'import'],
      ['VINHO TINTO SECO 750ML', null, null],
      ['CERVEJA', null, null],
    ]);
  });

  it('categoria fora das 11: recusa antes de abrir conexão (host inalcançável), sem criar encarte', async () => {
    const before = await count('flyer_pro_documents');
    const unreachable = temp.url.replace(/@[^/]+\//, '@127.0.0.1:1/');
    for (const category of ['ADEGA', 'Frios e Laticínios']) {
      const items = JSON.stringify([{ name: 'A', unit: 'kg', cents: 1, category }]);
      await expect(
        runFlyerProCaseCommand(['create', '--case', 'x', ...VERSIONS, '--items', items], {
          [E2E_DB_ENV]: unreachable,
        }),
      ).rejects.toThrow(/items\[0\]\.category inválida/);
    }
    expect(await count('flyer_pro_documents')).toBe(before);
  });

  it('versão ausente: recusa citando engineVersion, sem gravar nada', async () => {
    const before = await count('flyer_pro_documents');
    await expect(create('--case', 'sem versão', '--schema-version', '1')).rejects.toThrow(
      /engineVersion/,
    );
    expect(await count('flyer_pro_documents')).toBe(before);
  });

  it('apagar: zera os encartes dos dois clientes da semente, mantém o de outro cliente e a semente reaplica', async () => {
    await purge();
    await create('--case', 'do cliente com biblioteca', ...VERSIONS);
    const legacyId = await clientIdOf(FIXED_IDENTITY.clientLegacyFooter.cnpj);
    await insertDocument(dataSource, { clientId: legacyId, engineVersion: 1 });
    const otherClient = await insertClient(dataSource, 'Cliente de outro lugar');
    const kept = await insertDocumentWithItems(
      dataSource,
      { clientId: otherClient, engineVersion: 1 },
      2,
    );
    const clientsBefore = await count('clients');
    const scenesBefore = await count('template_scenes');
    expect(await count('flyer_pro_documents')).toBe(3);
    expect(await count('flyer_pro_items')).toBe(5);

    expect(await purge()).toEqual({ deleted: 2 });

    expect((await documents().find()).map((doc) => doc.id)).toEqual([kept.id]);
    expect(await count('flyer_pro_items')).toBe(2);
    expect(await count('clients')).toBe(clientsBefore);
    expect(await count('template_scenes')).toBe(scenesBefore);
    expect(await purge()).toEqual({ deleted: 0 });
    await expect(
      runE2eSeedCommand({ ...env(), UPLOAD_DEST: uploadsDir, CDN_URL: CDN }),
    ).resolves.toMatchObject({ email: FIXED_IDENTITY.email });
  });

  it('banco do ambiente: recusa antes de conectar (host inalcançável), com o nome do banco', async () => {
    const flyer = urlWithDatabase(E2E_DB_URL as string, 'flyer_db').replace(
      /@[^/]+\//,
      '@127.0.0.1:1/',
    );
    for (const argv of [['create', '--case', 'x', ...VERSIONS], ['purge']]) {
      await expect(runFlyerProCaseCommand(argv, { [E2E_DB_ENV]: flyer })).rejects.toThrow(
        /nunca usa o flyer_db/,
      );
    }
  });
});
