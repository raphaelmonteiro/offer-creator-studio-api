import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import { TemplateScenesGcRunner } from '../../../shared/gc/template-scenes-gc.runner';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneAsset } from '../entities/template-scene-asset.entity';
import { pruneSceneAssets } from '../services/scene-retention';
import { near, pixelOf, Rgb } from '../testing/scene-template-fixtures';
import { useSyncHarness } from '../testing/scene-template-sync-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';

const RED: Rgb = [220, 20, 20];
const BLUE: Rgb = [20, 20, 220];

describeIfSceneDb(
  'SceneTemplateSyncProcessor: concorrência, falha e retenção (banco chroma_x_e2e)',
  () => {
    const h = useSyncHarness();

    afterEach(() => {
      jest.restoreAllMocks();
      delete process.env.TEMPLATE_SCENE_MASTERS_KEPT;
    });

    /** Roda `during` quando a projeção grava o primeiro arquivo: a cena muda no meio do trabalho do job. */
    const duringProjection = (during: () => Promise<unknown>) => {
      const original = h.templateFiles.writeProjection.bind(h.templateFiles);
      jest.spyOn(h.templateFiles, 'writeProjection').mockImplementationOnce(async (...args) => {
        await during();
        return original(...args);
      });
    };

    describe('Cena mudou durante a projeção', () => {
      it('descarta o resultado da versão antiga e o job seguinte termina com a versão nova', async () => {
        const { scene } = await h.readySmall();
        duringProjection(() => h.newImageVersion(scene, 2, RED));

        await h.sync(scene.id);

        expect(await h.templatesOf(scene.id)).toEqual([]);
        await h.sync(scene.id);
        const template = await h.templateOf(scene.id);
        expect(
          near(
            await pixelOf(await h.fileOfUrl(template.config.bodyBackground.imageUrl), 50, 300),
            RED,
          ),
        ).toBe(true);
      });

      it('com template já existente, ele fica como estava até o job seguinte', async () => {
        const { scene } = await h.readySmall();
        await h.sync(scene.id);
        const before = await h.templateOf(scene.id);
        await h.newImageVersion(scene, 2, RED);
        const v3 = { id: '' };
        duringProjection(async () => {
          v3.id = (await h.newImageVersion(scene, 3, BLUE)).id;
        });

        await h.sync(scene.id);

        expect((await h.templateOf(scene.id)).config).toEqual(before.config);
        await h.sync(scene.id);
        expect((await h.templateOf(scene.id)).config.source.versionId).toBe(v3.id);
      });
    });

    describe('Cena excluída durante a projeção', () => {
      it('nenhum template é criado', async () => {
        const { scene } = await h.readySmall();
        duringProjection(() =>
          h.dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
            scene.id,
          ]),
        );

        await h.sync(scene.id);

        expect(await h.templatesOf(scene.id)).toEqual([]);
        expect(
          (await h.sceneRow(scene.id).catch(() => null))?.approvedTemplateId ?? null,
        ).toBeNull();
      });

      it('cena já excluída: o job encerra sem fazer nada', async () => {
        const { scene } = await h.readySmall();
        await h.dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
          scene.id,
        ]);
        await h.sync(scene.id);
        expect(await h.templatesOf(scene.id)).toEqual([]);
        expect(await h.filesOf(scene.id)).toEqual([]);
      });
    });

    describe('Falha da projeção', () => {
      async function sceneWithBrokenNewVersion() {
        const { scene } = await h.readySmall();
        await h.sync(scene.id);
        const version = await h.newImageVersion(scene, 2, RED);
        const master = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
          id: version.masterAssetId as string,
        });
        const bytes = await fs.readFile(h.files.absolutePath(master.url));
        await fs.rm(h.files.absolutePath(master.url));
        return {
          scene,
          version,
          restoreMaster: () => fs.writeFile(h.files.absolutePath(master.url), bytes),
        };
      }

      it('o template fica como estava, a falha vai para metrics.templateSync da versão e a revisão não muda', async () => {
        const { scene, version } = await sceneWithBrokenNewVersion();
        const before = await h.templateOf(scene.id);
        const revision = (await h.sceneRow(scene.id)).revision;

        await expect(h.sync(scene.id)).rejects.toThrow('Master da versão ausente');

        expect((await h.templateOf(scene.id)).config).toEqual(before.config);
        expect((await h.versionOf(version.id)).metrics.templateSync).toMatchObject({
          attempts: 1,
          sceneRevision: revision,
          error: 'Master da versão ausente',
        });
        expect((await h.sceneRow(scene.id)).revision).toBe(revision);
      });

      it('cada tentativa soma uma falha na mesma revisão, e o sucesso limpa o registro', async () => {
        const { scene, version, restoreMaster } = await sceneWithBrokenNewVersion();
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await expect(h.sync(scene.id)).rejects.toThrow();
          expect((await h.versionOf(version.id)).metrics.templateSync).toMatchObject({
            attempts: attempt,
          });
        }

        await restoreMaster();
        await h.sync(scene.id);

        expect((await h.versionOf(version.id)).metrics.templateSync).toBeUndefined();
        expect((await h.templateOf(scene.id)).config.source.versionId).toBe(version.id);
      });

      it('revisão nova zera a contagem', async () => {
        const { scene, version } = await sceneWithBrokenNewVersion();
        await expect(h.sync(scene.id)).rejects.toThrow();
        await h.bumpRevision(scene.id);
        await expect(h.sync(scene.id)).rejects.toThrow();
        expect((await h.versionOf(version.id)).metrics.templateSync).toMatchObject({ attempts: 1 });
      });

      it('erro de escrita na primeira vez: nenhum template e a falha registrada', async () => {
        const { scene, version } = await h.readySmall();
        jest
          .spyOn(h.templateFiles, 'writeProjection')
          .mockRejectedValueOnce(new Error('disco cheio'));

        await expect(h.sync(scene.id)).rejects.toThrow('disco cheio');

        expect(await h.templatesOf(scene.id)).toEqual([]);
        expect((await h.versionOf(version.id)).metrics.templateSync).toMatchObject({
          error: 'disco cheio',
        });
      });

      it('formato que saiu da lista: falha registrada, sem derrubar o job em loop silencioso', async () => {
        const { scene, version } = await h.readySmall();
        await h.dataSource.query(
          `UPDATE template_scenes SET "formatId" = 'formato-que-nao-existe' WHERE id = $1`,
          [scene.id],
        );
        await expect(h.sync(scene.id)).rejects.toThrow('Formato da cena sem medidas');
        expect((await h.versionOf(version.id)).metrics.templateSync).toMatchObject({ attempts: 1 });
      });
    });

    describe('Retenção das masters intacta', () => {
      it('com 21 versões sincronizadas, o GC apaga a master da 1 e o template continua com a imagem', async () => {
        const { scene, version: v1 } = await h.readySmall();
        await h.sync(scene.id);
        const first = await h.templateOf(scene.id);
        for (let number = 2; number <= 21; number += 1) {
          await h.newImageVersion(scene, number, number % 2 ? RED : BLUE);
          await h.sync(scene.id);
        }
        await h.dataSource.transaction(async (manager) =>
          pruneSceneAssets(manager, await manager.findOneByOrFail(TemplateScene, { id: scene.id })),
        );

        const gc = new TemplateScenesGcRunner(
          h.dataSource,
          new ConfigService({ UPLOAD_DEST: h.uploadsDir }),
        );
        const summary = await gc.run({
          dryRun: false,
          now: new Date(Date.now() + 60_000),
          onlySceneIds: [scene.id],
        });

        expect(summary.deleted).toBeGreaterThan(0);
        const master = await h.dataSource.manager.findOneByOrFail(TemplateSceneAsset, {
          id: v1.masterAssetId as string,
        });
        expect(master.purgedAt).not.toBeNull();
        const versions = await h.dataSource.query(
          `SELECT count(*)::int AS n FROM template_scene_versions WHERE "sceneId" = $1 AND "approvedAt" IS NOT NULL`,
          [scene.id],
        );
        expect(versions[0].n).toBe(0);
        const template = await h.templateOf(scene.id);
        await expect(h.fileOfUrl(template.config.bodyBackground.imageUrl)).resolves.toBeInstanceOf(
          Buffer,
        );
        await expect(h.fileOfUrl(first.config.bodyBackground.imageUrl)).resolves.toBeInstanceOf(
          Buffer,
        );
      });
    });
  },
);
