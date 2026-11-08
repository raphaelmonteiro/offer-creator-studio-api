import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import {
  SCENE_UPLOADS_URL_PREFIX,
  TemplateScenesGcRunner,
} from '../../../shared/gc/template-scenes-gc.runner';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  insertAsset,
  insertReadyOnDisk,
  insertScene,
  insertVersion,
  pointFace,
} from '../testing/scene-fixtures';
import { errorOf, textElement, fakeQueue } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneFilesService } from './scene-files.service';
import { SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { pruneSceneAssets } from './scene-retention';
import { SceneVersionsService } from './scene-versions.service';

const DAY_MS = 24 * 60 * 60 * 1000;

describeIfSceneDb('Retenção de assets e GC das cenas (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let uploadsDir: string;
  let files: SceneFilesService;
  let versions: SceneVersionsService;
  let gc: TemplateScenesGcRunner;
  const createdScenes: string[] = [];
  const env = { ...process.env };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await openSceneTestDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-gc-'));
    const config = new ConfigService({ UPLOAD_DEST: uploadsDir });
    files = new SceneFilesService(config);
    versions = new SceneVersionsService(
      dataSource,
      new SceneLockService(dataSource),
      new SceneReadService(dataSource),
      fakeQueue().service,
    );
    gc = new TemplateScenesGcRunner(dataSource, config);
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

  // As regras são paramétricas: a maioria dos cenários usa 5 vagas para ficar leve; o padrão de 20 (D-34) tem os seus.
  beforeEach(() => {
    process.env.TEMPLATE_SCENE_MASTERS_KEPT = '5';
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const exists = (url: string) =>
    fs.access(files.absolutePath(url)).then(
      () => true,
      () => false,
    );
  const later = () => new Date(Date.now() + 60_000);

  /** Versão `ready` com master e prévia próprias, com arquivo em disco. */
  const addReadyOnDisk = (
    scene: TemplateScene,
    number: number,
    extra: Partial<TemplateSceneVersion> = {},
  ) => insertReadyOnDisk(dataSource, files, scene, { number, extra });

  async function sceneWith(name: string, count: number) {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    const ready = [];
    for (let number = 1; number <= count; number++) ready.push(await addReadyOnDisk(scene, number));
    await pointFace(
      dataSource,
      { id: scene.id, currentVersionId: null },
      ready[count - 1].version.id,
    );
    return { scene, ready };
  }

  const prune = (sceneId: string) =>
    dataSource.transaction(async (manager) =>
      pruneSceneAssets(manager, await manager.findOneByOrFail(TemplateScene, { id: sceneId })),
    );
  const purge = (sceneId: string, dryRun = false) =>
    gc.run({ dryRun, now: later(), onlySceneIds: [sceneId] });
  const assetRow = (id: string) => dataSource.manager.findOneByOrFail(TemplateSceneAsset, { id });

  it('sexta versão poda a mais antiga: some do disco, fica no banco com metadados', async () => {
    const { scene, ready } = await sceneWith('GC sexta versão', 5);
    await prune(scene.id);
    expect((await assetRow(ready[0].master.id)).expiresAt).toBeNull();

    const sixth = await addReadyOnDisk(scene, 6);
    await prune(scene.id);
    const summary = await purge(scene.id);

    expect(summary.selected).toBe(2);
    expect(summary.deleted).toBe(2);
    expect(await exists(ready[0].master.url)).toBe(false);
    expect(await exists(ready[0].preview.url)).toBe(false);
    for (const item of [...ready.slice(1), sixth]) {
      expect(await exists(item.master.url)).toBe(true);
      expect(await exists(item.preview.url)).toBe(true);
    }
    expect((await assetRow(ready[0].master.id)).purgedAt).not.toBeNull();
    expect(await dataSource.manager.countBy(TemplateSceneVersion, { sceneId: scene.id })).toBe(6);
  });

  it('poda por edição manual: o PATCH cria a versão 6 e a master da 1 sai', async () => {
    const { scene, ready } = await sceneWith('GC poda manual', 5);

    await versions.patchElements(
      scene.id,
      { expectedRevision: 0, elements: [textElement('t')] },
      null,
    );
    await purge(scene.id);

    expect(await exists(ready[0].master.url)).toBe(false);
    expect(await exists(ready[4].master.url)).toBe(true);
  });

  it('Tentativas ocupam as vagas da retenção: 5 tentativas seguidas, a atual e a aprovada intactas (D-20, R22)', async () => {
    const { scene, ready } = await sceneWith('GC tentativas', 2);
    await dataSource.manager.update(
      TemplateSceneVersion,
      { id: ready[1].version.id },
      { approvedAt: new Date() },
    );
    await pointFace(dataSource, { id: scene.id, currentVersionId: null }, ready[0].version.id);
    const attempts = [];
    for (let number = 3; number <= 7; number++) {
      attempts.push(
        await addReadyOnDisk(scene, number, {
          metrics: { judge: { available: true, satisfied: 'nao' } },
        }),
      );
    }

    await prune(scene.id);
    const summary = await purge(scene.id);

    expect(summary.selected).toBe(0);
    for (const item of [...ready, ...attempts]) {
      expect(await exists(item.master.url)).toBe(true);
      expect(await exists(item.preview.url)).toBe(true);
      expect((await assetRow(item.master.id)).expiresAt).toBeNull();
    }
  });

  it('a atual fora das 5 vagas e sem aprovação também fica protegida; a sexta tentativa poda a mais antiga', async () => {
    const { scene, ready } = await sceneWith('GC atual fora das vagas', 1);
    await pointFace(dataSource, { id: scene.id, currentVersionId: null }, ready[0].version.id);
    const attempts = [];
    for (let number = 2; number <= 7; number++) {
      attempts.push(
        await addReadyOnDisk(scene, number, {
          metrics: { judge: { available: true, satisfied: 'nao' } },
        }),
      );
    }

    await prune(scene.id);
    await purge(scene.id);

    expect(await exists(ready[0].master.url)).toBe(true);
    expect(await exists(ready[0].preview.url)).toBe(true);
    expect(await exists(attempts[0].master.url)).toBe(false);
    expect(await exists(attempts[5].master.url)).toBe(true);
  });

  it('versão aprovada continua protegida mesmo com 7 versões depois dela', async () => {
    const { scene, ready } = await sceneWith('GC aprovada', 1);
    await dataSource.manager.update(
      TemplateSceneVersion,
      { id: ready[0].version.id },
      { approvedAt: new Date() },
    );
    for (let number = 2; number <= 8; number++) await addReadyOnDisk(scene, number);

    await prune(scene.id);
    await purge(scene.id);

    expect(await exists(ready[0].master.url)).toBe(true);
    expect((await assetRow(ready[0].master.id)).expiresAt).toBeNull();
    expect(await exists(files.urlFor(scene.id, ready[0].version.id, 'master-1.png'))).toBe(true);
  });

  it('master compartilhada: a versão 2 fica restaurável porque a manual 8 a usa', async () => {
    const { scene, ready } = await sceneWith('GC compartilhada', 7);
    await insertVersion(dataSource, scene.id, {
      number: 8,
      operation: 'manual',
      masterAssetId: ready[1].master.id,
      previewAssetId: ready[1].preview.id,
    });

    await prune(scene.id);
    await purge(scene.id);

    expect(await exists(ready[1].master.url)).toBe(true);
    expect(await exists(ready[1].preview.url)).toBe(true);
    expect(await exists(ready[0].master.url)).toBe(false);
    expect(await exists(ready[2].master.url)).toBe(false);
    const restored = await versions.restore(scene.id, ready[1].version.id, null);
    expect(restored.currentVersion?.master?.url).toBe(ready[1].master.url);
  });

  it('restore antes do GC: a master volta ao conjunto protegido e não é apagada', async () => {
    const { scene, ready } = await sceneWith('GC restore antes', 6);
    await prune(scene.id);
    expect((await assetRow(ready[0].master.id)).expiresAt).not.toBeNull();

    await versions.restore(scene.id, ready[0].version.id, null);
    await purge(scene.id);

    expect(await exists(ready[0].master.url)).toBe(true);
    expect((await assetRow(ready[0].master.id)).purgedAt).toBeNull();
  });

  it('GC antes do restore: purgedAt gravado, o restore dá 410 e nenhuma versão é criada', async () => {
    const { scene, ready } = await sceneWith('GC restore depois', 6);
    await prune(scene.id);
    await purge(scene.id);

    expect(await errorOf(versions.restore(scene.id, ready[0].version.id, null))).toEqual({
      status: 410,
      code: 'VERSION_NOT_RESTORABLE',
    });
    expect(await dataSource.manager.countBy(TemplateSceneVersion, { sceneId: scene.id })).toBe(6);
  });

  it('restore e GC ao mesmo tempo: nunca fica versão apontando para arquivo apagado', async () => {
    for (let round = 0; round < 4; round++) {
      const { scene, ready } = await sceneWith(`GC corrida ${round}`, 6);
      await prune(scene.id);

      await Promise.allSettled([
        versions.restore(scene.id, ready[0].version.id, null),
        purge(scene.id),
      ]);

      const current = await dataSource.manager.findOneByOrFail(TemplateScene, { id: scene.id });
      const currentVersion = await dataSource.manager.findOneByOrFail(TemplateSceneVersion, {
        id: current.currentVersionId as string,
      });
      const master = await assetRow(currentVersion.masterAssetId as string);
      expect(master.purgedAt).toBeNull();
      expect(await exists(master.url)).toBe(true);
    }
  });

  it('cena excluída há 31 dias: todos os arquivos e a pasta da cena saem', async () => {
    const { scene, ready } = await sceneWith('GC excluída', 3);
    const logo = await insertAsset(dataSource, ready[0].version, 'logo', {
      url: (await files.write(scene.id, ready[0].version.id, 'logo-x.png', Buffer.from('l'))).url,
    });
    await dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { deletedAt: new Date(Date.now() - 31 * DAY_MS) },
    );

    const summary = await purge(scene.id);

    expect(summary.selected).toBe(7);
    for (const url of [...ready.flatMap((r) => [r.master.url, r.preview.url]), logo.url]) {
      expect(await exists(url)).toBe(false);
    }
    await expect(fs.access(path.join(uploadsDir, 'template-scenes', scene.id))).rejects.toThrow();
  });

  it('cena excluída há 29 dias ainda mantém os arquivos', async () => {
    const { scene, ready } = await sceneWith('GC excluída recente', 2);
    await dataSource.manager.update(
      TemplateScene,
      { id: scene.id },
      { deletedAt: new Date(Date.now() - 29 * DAY_MS) },
    );
    const summary = await purge(scene.id);
    expect(summary.selected).toBe(0);
    expect(await exists(ready[0].master.url)).toBe(true);
  });

  it('simulação: registra a seleção e não apaga nada', async () => {
    const { scene, ready } = await sceneWith('GC simulação', 6);
    await prune(scene.id);

    const summary = await purge(scene.id, true);

    expect(summary).toMatchObject({ dryRun: true, selected: 2, deleted: 0 });
    expect(summary.files).toEqual(
      expect.arrayContaining([ready[0].master.url, ready[0].preview.url]),
    );
    expect(await exists(ready[0].master.url)).toBe(true);
    expect((await assetRow(ready[0].master.id)).purgedAt).toBeNull();
  });

  it('padrão sem TEMPLATE_SCENE_GC_DRY_RUN é simulação; só false apaga', async () => {
    const { scene, ready } = await sceneWith('GC padrão', 6);
    await prune(scene.id);
    delete process.env.TEMPLATE_SCENE_GC_DRY_RUN;
    const dry = await gc.run({ now: later(), onlySceneIds: [scene.id] });
    expect(dry.dryRun).toBe(true);
    expect(await exists(ready[0].master.url)).toBe(true);

    process.env.TEMPLATE_SCENE_GC_DRY_RUN = 'false';
    const real = await gc.run({ now: later(), onlySceneIds: [scene.id] });
    expect(real.dryRun).toBe(false);
    expect(await exists(ready[0].master.url)).toBe(false);
  });

  it('o GC global (GC_DRY_RUN) não muda o comportamento das cenas', async () => {
    const { scene, ready } = await sceneWith('GC independente', 6);
    await prune(scene.id);
    process.env.GC_DRY_RUN = 'false';
    delete process.env.TEMPLATE_SCENE_GC_DRY_RUN;
    const summary = await gc.run({ now: later(), onlySceneIds: [scene.id] });
    expect(summary.dryRun).toBe(true);
    expect(await exists(ready[0].master.url)).toBe(true);
  });

  it('intermediários expiram pelo TTL; logo e elementos ficam', async () => {
    const { scene, ready } = await sceneWith('GC TTL', 1);
    const make = async (role: 'raw_output' | 'logo', name: string, ageDays: number) => {
      const written = await files.write(scene.id, ready[0].version.id, name, Buffer.from(name));
      return insertAsset(dataSource, ready[0].version, role, {
        url: written.url,
        createdAt: new Date(Date.now() - ageDays * DAY_MS),
      });
    };
    const oldRaw = await make('raw_output', 'raw-old.png', 8);
    const freshRaw = await make('raw_output', 'raw-new.png', 6);
    const oldLogo = await make('logo', 'logo-old.png', 90);

    await purge(scene.id);

    expect(await exists(oldRaw.url)).toBe(false);
    expect(await exists(freshRaw.url)).toBe(true);
    expect(await exists(oldLogo.url)).toBe(true);
  });

  it('só apaga sob /uploads/template-scenes/: URL fora do prefixo nunca é tocada', async () => {
    const { scene, ready } = await sceneWith('GC prefixo', 6);
    const outside = path.join(uploadsDir, 'products', 'precioso.png');
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, 'não apagar');
    await insertAsset(dataSource, ready[0].version, 'master', {
      url: '/uploads/products/precioso.png',
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    await insertAsset(dataSource, ready[0].version, 'master', {
      url: `${SCENE_UPLOADS_URL_PREFIX}../products/precioso.png`,
      expiresAt: new Date(Date.now() - DAY_MS),
    });
    await prune(scene.id);

    const summary = await purge(scene.id);

    expect(await fs.readFile(outside, 'utf8')).toBe('não apagar');
    expect(summary.files.every((url) => url.startsWith(SCENE_UPLOADS_URL_PREFIX))).toBe(true);
    expect(summary.files).not.toContain('/uploads/products/precioso.png');
  });

  describe('Retenção com 20 (D-34)', () => {
    beforeEach(() => {
      delete process.env.TEMPLATE_SCENE_MASTERS_KEPT;
    });

    it('o padrão guarda as 20 mais recentes: com 21 versões, só a primeira sai', async () => {
      const { scene, ready } = await sceneWith('GC 21 versões', 21);
      await prune(scene.id);
      const summary = await purge(scene.id);

      expect(summary.selected).toBe(2);
      expect(await exists(ready[0].master.url)).toBe(false);
      expect(await exists(ready[0].preview.url)).toBe(false);
      for (const item of ready.slice(1)) {
        expect(await exists(item.master.url)).toBe(true);
        expect((await assetRow(item.master.id)).expiresAt).toBeNull();
      }
    });

    it('com 20 versões nada sai, inclusive a que o juiz reprovou: toda imagem conta', async () => {
      const { scene, ready } = await sceneWith('GC 20 versões', 20);
      await dataSource.manager.update(
        TemplateSceneVersion,
        { id: ready[10].version.id },
        { metrics: { judge: { available: true, satisfied: 'nao' } } },
      );
      await prune(scene.id);
      const summary = await purge(scene.id);
      expect(summary.selected).toBe(0);
      expect(await exists(ready[10].master.url)).toBe(true);
    });

    it('a atual fora das 20 vagas e a aprovada continuam protegidas (D-20)', async () => {
      const { scene, ready } = await sceneWith('GC atual e aprovada', 24);
      await dataSource.manager.update(
        TemplateSceneVersion,
        { id: ready[1].version.id },
        { approvedAt: new Date() },
      );
      await pointFace(dataSource, { id: scene.id, currentVersionId: null }, ready[0].version.id);
      await prune(scene.id);
      await purge(scene.id);

      // as 20 mais recentes são os índices 4 a 23; a atual (0) e a aprovada (1) ficam, e só 2 e 3 saem
      expect(await exists(ready[0].master.url)).toBe(true);
      expect(await exists(ready[1].master.url)).toBe(true);
      expect(await exists(ready[2].master.url)).toBe(false);
      expect(await exists(ready[3].master.url)).toBe(false);
      expect(await exists(ready[4].master.url)).toBe(true);
    });

    it('restore e manual contam como versões, mas reaproveitam a master: nenhum arquivo novo, e a master reaproveitada fica protegida', async () => {
      const { scene, ready } = await sceneWith('GC reaproveita', 20);
      await versions.restore(scene.id, ready[5].version.id, null);
      await versions.patchElements(
        scene.id,
        { expectedRevision: 1, elements: [textElement('t')] },
        null,
      );
      await purge(scene.id);

      const stored = await dataSource.manager.countBy(TemplateSceneAsset, {
        sceneId: scene.id,
        role: 'master',
      });
      expect(stored).toBe(20);
      // 22 versões: as 20 mais recentes são 3 a 22, então 1 e 2 saem; a 6 foi reaproveitada e segue em disco
      expect(await exists(ready[0].master.url)).toBe(false);
      expect(await exists(ready[1].master.url)).toBe(false);
      expect(await exists(ready[5].master.url)).toBe(true);
    });
  });
});
