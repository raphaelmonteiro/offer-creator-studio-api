import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { TemplateScenesGcRunner } from '../../../shared/gc/template-scenes-gc.runner';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { insertReadyOnDisk, insertScene, pointFace } from '../testing/scene-fixtures';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneFilesService } from './scene-files.service';
import { pruneSceneAssets } from './scene-retention';

describeIfSceneDb('Retenção das masters por face (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let uploadsDir: string;
  let files: SceneFilesService;
  let gc: TemplateScenesGcRunner;
  const createdScenes: string[] = [];
  const env = { ...process.env };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await openSceneTestDb();
    uploadsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-gc-faces-'));
    const config = new ConfigService({ UPLOAD_DEST: uploadsDir });
    files = new SceneFilesService(config);
    gc = new TemplateScenesGcRunner(dataSource, config);
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
    await fs.rm(uploadsDir, { recursive: true, force: true });
  });

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
  const prune = (sceneId: string) =>
    dataSource.transaction(async (manager) =>
      pruneSceneAssets(manager, await manager.findOneByOrFail(TemplateScene, { id: sceneId })),
    );
  const purge = (sceneId: string) =>
    gc.run({ dryRun: false, now: new Date(Date.now() + 60_000), onlySceneIds: [sceneId] });

  /** Cena de frente e verso com `front` e `back` versões `ready` em disco (números 1.. alternados, a frente primeiro). */
  async function sceneWith(name: string, counts: { front: number; back: number }) {
    const scene = await insertScene(dataSource, { name, layout: 'front_back' });
    createdScenes.push(scene.id);
    const front = [];
    const back = [];
    let number = 0;
    for (const [face, count, bucket] of [
      [0, counts.front, front],
      [1, counts.back, back],
    ] as const) {
      for (let item = 0; item < count; item += 1) {
        number += 1;
        bucket.push(
          await insertReadyOnDisk(dataSource, files, scene, { number, extra: { faceIndex: face } }),
        );
      }
    }
    return { scene, front, back };
  }

  it('Retenção por face: 5 vagas, a frente com 3 e o verso com 6: só a master da versão 1 do verso é apagada', async () => {
    const { scene, front, back } = await sceneWith('Retenção FV', { front: 3, back: 6 });
    await pointFace(dataSource, scene, front[2].version.id, 0);
    await pointFace(dataSource, scene, back[5].version.id, 1);

    await prune(scene.id);
    const summary = await purge(scene.id);

    expect(summary.deleted).toBe(2); // master e prévia da versão 1 do verso
    expect(await exists(back[0].master.url)).toBe(false);
    for (const item of [...front, ...back.slice(1)]) {
      expect(await exists(item.master.url)).toBe(true);
    }
    const row = await dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
      id: back[0].master.id,
    });
    expect(row.purgedAt).not.toBeNull();
  });

  it('Frente atual antiga protegida: a versão atual da frente, fora das 5 mais recentes, continua no disco', async () => {
    const { scene, front, back } = await sceneWith('Retenção atual antiga', { front: 7, back: 6 });
    // a frente atual é a mais antiga: fora das 5 mais recentes da própria frente
    await pointFace(dataSource, scene, front[0].version.id, 0);
    await pointFace(dataSource, scene, back[5].version.id, 1);

    await prune(scene.id);
    await purge(scene.id);

    expect(await exists(front[0].master.url)).toBe(true);
    expect(await exists(front[0].preview.url)).toBe(true);
    // a versão 2 da frente não é a atual nem das 5 mais recentes da frente: sai
    expect(await exists(front[1].master.url)).toBe(false);
    expect(await exists(front[2].master.url)).toBe(true);
    expect(await exists(back[0].master.url)).toBe(false);
    expect(await exists(back[5].master.url)).toBe(true);
  });

  it('a retenção da cena de uma face segue contando na cena inteira (a face 0)', async () => {
    const scene = await insertScene(dataSource, { name: 'Retenção single' });
    createdScenes.push(scene.id);
    const ready = [];
    for (let number = 1; number <= 6; number += 1) {
      ready.push(await insertReadyOnDisk(dataSource, files, scene, { number }));
    }
    await pointFace(dataSource, scene, ready[5].version.id, 0);

    await prune(scene.id);
    await purge(scene.id);

    expect(await exists(ready[0].master.url)).toBe(false);
    for (const item of ready.slice(1)) expect(await exists(item.master.url)).toBe(true);
  });
});
