import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { DataSource } from 'typeorm';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { insertReadyVersion, insertScene } from '../testing/scene-fixtures';
import { errorBodyOf, errorOf } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneFilesService } from './scene-files.service';
import { SceneLogoService } from './scene-logo.service';

const png = (width = 40, height = 20) =>
  sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
    .png()
    .toBuffer();

const upload = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, size: buffer.length });

describeIfSceneDb('SceneLogoService (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let service: SceneLogoService;
  let dir: string;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-logo-'));
    service = new SceneLogoService(
      dataSource,
      new SceneFilesService(new ConfigService({ UPLOAD_DEST: dir })),
    );
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function sceneWithVersion(name: string) {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    const { version } = await insertReadyVersion(dataSource, scene, 1);
    return { scene, version };
  }

  const assetsOf = (sceneId: string) =>
    dataSource.manager.findBy(TemplateSceneAsset, { sceneId, role: 'logo' });

  it('PNG válido: grava o arquivo sob a pasta da versão e registra o asset', async () => {
    const { scene, version } = await sceneWithVersion('Logo ok');

    const result = await service.upload(scene.id, upload(await png(40, 20), 'image/png'));

    expect(result).toMatchObject({ width: 40, height: 20 });
    expect(result.url).toMatch(
      new RegExp(`^/uploads/template-scenes/${scene.id}/${version.id}/logo-[0-9a-f-]+\\.png$`),
    );
    const [asset] = await assetsOf(scene.id);
    expect(asset).toMatchObject({
      id: result.assetId,
      versionId: version.id,
      role: 'logo',
      expiresAt: null,
    });
    const disk = await fs.readFile(path.join(dir, result.url.replace('/uploads/', '')));
    expect(disk.length).toBe(asset.bytes);
  });

  it.each([
    ['jpeg', 'image/jpeg', 'jpg'],
    ['webp', 'image/webp', 'webp'],
  ] as const)('aceita %s', async (format, mimetype, extension) => {
    const { scene } = await sceneWithVersion(`Logo ${format}`);
    const buffer = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#00f' },
    })
      .toFormat(format)
      .toBuffer();
    const result = await service.upload(scene.id, upload(buffer, mimetype));
    expect(result.url.endsWith(`.${extension}`)).toBe(true);
  });

  it('SVG: 422 LOGO_INVALID e nada é gravado (nem com cabeçalho image/png)', async () => {
    const { scene } = await sceneWithVersion('Logo svg');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

    for (const mimetype of ['image/svg+xml', 'image/png']) {
      expect(await errorOf(service.upload(scene.id, upload(svg, mimetype)))).toEqual({
        status: 422,
        code: 'LOGO_INVALID',
      });
    }
    expect(await assetsOf(scene.id)).toHaveLength(0);
    await expect(fs.access(path.join(dir, 'template-scenes', scene.id))).rejects.toThrow();
  });

  it('acima de 10 MB: 422 com o motivo', async () => {
    const { scene } = await sceneWithVersion('Logo grande');
    const body = await errorBodyOf(
      service.upload(scene.id, upload(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png')),
    );
    expect(body).toMatchObject({ code: 'LOGO_INVALID' });
    expect(String(body.message)).toContain('10 MB');
    expect(await assetsOf(scene.id)).toHaveLength(0);
  });

  it.each([
    ['sem arquivo', undefined],
    ['arquivo vazio', upload(Buffer.alloc(0), 'image/png')],
    ['GIF', upload(Buffer.from('GIF89a'), 'image/gif')],
    ['PNG corrompido', upload(Buffer.from('não é imagem'), 'image/png')],
  ])('%s: 422 LOGO_INVALID', async (_label, file) => {
    const { scene } = await sceneWithVersion('Logo inválido');
    expect(await errorOf(service.upload(scene.id, file))).toEqual({
      status: 422,
      code: 'LOGO_INVALID',
    });
  });

  it('cena sem versão: 422 NO_CURRENT_VERSION pedindo para gerar antes (nada é gravado)', async () => {
    const scene = await insertScene(dataSource, { name: 'Logo sem versão' });
    createdScenes.push(scene.id);
    const body = await errorBodyOf(service.upload(scene.id, upload(await png(), 'image/png')));
    expect(body).toMatchObject({ code: 'NO_CURRENT_VERSION' });
    expect(String(body.message)).toContain('Gere a cena');
    expect(await assetsOf(scene.id)).toHaveLength(0);
  });

  it('cena inexistente ou excluída: 404', async () => {
    const { scene } = await sceneWithVersion('Logo excluída');
    await dataSource.manager.softDelete('template_scenes', { id: scene.id });
    expect(await errorOf(service.upload(scene.id, upload(await png(), 'image/png')))).toEqual({
      status: 404,
      code: 'SCENE_NOT_FOUND',
    });
  });
});
