import * as fs from 'fs/promises';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { User } from '../../modules/auth/entities/user.entity';
import { footerItem, headerItem, SECTION } from '../../modules/clients/clients.testutil';
import { Client } from '../../modules/clients/entities/client.entity';
import { solidPng } from '../../modules/template-scenes/testing/scene-template-fixtures';
import { deleteTestScenes } from '../../modules/template-scenes/testing/scene-test-db';
import { E2E_CDN_URL, SeedIdentity, uniqueIdentity } from './e2e-seed-identity';
import {
  createSceneSeeder,
  SceneSeeder,
  SeededScene,
  SeedFileTarget,
  seedScene,
} from './e2e-seed-scenes';

export interface SeededImage {
  id: string;
  filename: string;
  url: string;
  folderId: string;
}

export interface E2eSeed {
  identity: SeedIdentity;
  user: User;
  /** O cliente com 1 cabeçalho (`27x40`) e 2 rodapés, com `footer` espelhando o primeiro. */
  clientWithLibrary: Client;
  /** O cliente só com `footer` legado (`footers` e `headers` nulos). */
  clientLegacyFooter: Client;
  scenes: { frontBack: SeededScene; tabloid: SeededScene };
  folder: { id: string; name: string };
  images: SeededImage[];
  /** Apaga só o que esta semente criou, na ordem das FKs, inclusive os arquivos. Sem tocar outras suítes. */
  cleanup(): Promise<void>;
}

export interface E2eSeedOptions extends Partial<SeedFileTarget> {
  uploadsDir: string;
  /** Ids únicos por execução (suíte do Jest, o padrão) ou `FIXED_IDENTITY` (comando do e2e de navegador). */
  identity?: SeedIdentity;
}

/** Acha pelo e-mail ou cria; um usuário que já existe com outra senha volta a ter a da semente. */
async function seedUser(dataSource: DataSource, identity: SeedIdentity): Promise<User> {
  const users = dataSource.getRepository(User);
  const found = await users.findOneBy({ email: identity.email });
  if (!found) {
    return users.save(
      users.create({
        email: identity.email,
        password: identity.password, // o `@BeforeInsert` cifra
        name: identity.userName,
        emailVerified: true,
      }),
    );
  }
  if (await found.validatePassword(identity.password)) return found;
  found.password = identity.password; // o `@BeforeUpdate` cifra
  return users.save(found);
}

async function seedClient(
  dataSource: DataSource,
  data: { name: string; cnpj: string } & Partial<Client>,
): Promise<Client> {
  const clients = dataSource.getRepository(Client);
  const found = await clients.findOneBy({ cnpj: data.cnpj });
  return found ?? clients.save(clients.create(data));
}

async function seedClients(dataSource: DataSource, identity: SeedIdentity) {
  const footers = [footerItem('rodape-1', 'Rodapé 1'), footerItem('rodape-2', 'Rodapé 2')];
  const clientWithLibrary = await seedClient(dataSource, {
    ...identity.clientWithLibrary,
    headers: [headerItem('cabecalho-1', 'Cabeçalho 27x40')],
    footers,
    footer: footers[0].section,
  });
  const clientLegacyFooter = await seedClient(dataSource, {
    ...identity.clientLegacyFooter,
    footer: SECTION,
    footers: null,
    headers: null,
  });
  return { clientWithLibrary, clientLegacyFooter };
}

/** Acha a foto pelo nome do arquivo e a põe com a URL e a pasta atuais, ou a cria. */
async function upsertImage(
  dataSource: DataSource,
  image: { filename: string; url: string; size: number; folderId: string },
): Promise<string> {
  const { filename, url, size, folderId } = image;
  const [found] = await dataSource.query(`SELECT id FROM gallery_images WHERE filename = $1`, [
    filename,
  ]);
  if (found) {
    await dataSource.query(
      `UPDATE gallery_images SET url = $2, "thumbnailUrl" = $2, size = $3, "folderId" = $4 WHERE id = $1`,
      [found.id, url, size, folderId],
    );
    return found.id;
  }
  const [created] = await dataSource.query(
    `INSERT INTO gallery_images (filename, url, "thumbnailUrl", "mimeType", size, "folderId", metadata_status)
     VALUES ($1, $2, $2, 'image/png', $3, $4, 'ready') RETURNING id`,
    [filename, url, size, folderId],
  );
  return created.id;
}

async function seedGallery(dataSource: DataSource, identity: SeedIdentity, target: SeedFileTarget) {
  const dir = path.join(target.uploadsDir, 'gallery');
  await fs.mkdir(dir, { recursive: true });
  const [folder] = await dataSource.query(`SELECT id FROM gallery_folders WHERE name = $1`, [
    identity.folderName,
  ]);
  const folderId: string =
    folder?.id ??
    (
      await dataSource.query(`INSERT INTO gallery_folders (name) VALUES ($1) RETURNING id`, [
        identity.folderName,
      ])
    )[0].id;
  const images: SeededImage[] = [];
  for (const [index, filename] of identity.photoFiles.entries()) {
    const png = await solidPng(240, 240, index === 0 ? [200, 60, 60] : [60, 120, 200]);
    await fs.writeFile(path.join(dir, filename), png);
    const url = `${target.cdnUrl.replace(/\/+$/, '')}/gallery/${filename}`;
    const id = await upsertImage(dataSource, { filename, url, size: png.length, folderId });
    images.push({ id, filename, url, folderId });
  }
  return { folder: { id: folderId, name: identity.folderName }, images };
}

async function removeFiles(target: SeedFileTarget, seeded: SeededScene[], photos: string[]) {
  const paths = [
    ...seeded.flatMap((scene) => [
      path.join(target.uploadsDir, 'template-scenes', scene.id),
      path.join(target.uploadsDir, 'templates', `scene-${scene.id}`),
    ]),
    ...photos.map((filename) => path.join(target.uploadsDir, 'gallery', filename)),
  ];
  await Promise.all(paths.map((file) => fs.rm(file, { recursive: true, force: true })));
}

async function seedBothScenes(seeder: SceneSeeder, identity: SeedIdentity) {
  const frontBack = await seedScene(seeder, {
    name: identity.sceneFrontBack,
    formatId: 'folheto-27x40',
    layout: 'front_back',
    colors: [
      [220, 90, 60],
      [60, 140, 220],
    ],
  });
  const tabloid = await seedScene(seeder, {
    name: identity.sceneTabloid,
    formatId: 'folheto-54x40',
    layout: 'tabloid',
    colors: [
      [240, 200, 60],
      [90, 180, 120],
    ],
  });
  return { frontBack, tabloid };
}

/** Apaga o que a semente criou, na ordem das FKs (fotos, pasta, templates e cenas, clientes, usuário) e os arquivos. */
async function cleanupSeed(
  dataSource: DataSource,
  target: SeedFileTarget,
  seed: Omit<E2eSeed, 'cleanup'>,
): Promise<void> {
  const scenes = [seed.scenes.frontBack, seed.scenes.tabloid];
  await dataSource.query(`DELETE FROM gallery_images WHERE id = ANY($1::uuid[])`, [
    seed.images.map((image) => image.id),
  ]);
  await dataSource.query(`DELETE FROM gallery_folders WHERE id = $1`, [seed.folder.id]);
  await deleteTestScenes(
    dataSource,
    scenes.map((scene) => scene.id),
  );
  await dataSource.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [
    [seed.clientWithLibrary.id, seed.clientLegacyFooter.id],
  ]);
  await dataSource.query(`DELETE FROM users WHERE id = $1`, [seed.user.id]);
  await removeFiles(target, scenes, seed.identity.photoFiles);
}

/**
 * Aplica a semente: 1 usuário, 2 clientes, 2 cenas com template pronto por face (a rotina real do worker) e 1 pasta
 * com 2 fotos da Galeria, com os arquivos em `uploadsDir` e as URLs em `cdnUrl`. Idempotente por identificador: com
 * `FIXED_IDENTITY` repetir devolve os mesmos dados; com os ids únicos (o padrão) cada chamada cria os seus.
 * Chamar depois de `openE2eDb` (o banco já montado).
 */
export async function applyE2eSeed(
  dataSource: DataSource,
  options: E2eSeedOptions,
): Promise<E2eSeed> {
  const identity = options.identity ?? uniqueIdentity();
  const target: SeedFileTarget = {
    uploadsDir: options.uploadsDir,
    cdnUrl: options.cdnUrl ?? E2E_CDN_URL,
  };
  const user = await seedUser(dataSource, identity);
  const clients = await seedClients(dataSource, identity);
  const scenes = await seedBothScenes(createSceneSeeder(dataSource, target), identity);
  const gallery = await seedGallery(dataSource, identity, target);
  const seed = { identity, user, ...clients, scenes, ...gallery };
  return { ...seed, cleanup: () => cleanupSeed(dataSource, target, seed) };
}
