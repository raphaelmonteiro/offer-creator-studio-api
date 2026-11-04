import * as fs from 'fs/promises';
import * as path from 'path';
import * as sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { TemplateScene } from './entities/template-scene.entity';
import { SceneFilesService } from './services/scene-files.service';
import { insertReadyVersion, insertScene } from './testing/scene-fixtures';
import { E2E_ADMIN_TOKEN } from './testing/scene-e2e-app';
import { useE2eHarness } from './testing/scene-e2e-harness';
import { describeIfSceneDb } from './testing/scene-test-db';

/**
 * E2E da cena (cancelar, camadas, logo, restaurar e GC manual). Rodar com `TEMPLATE_SCENE_E2E_DB_URL=... npm run test --
 * template-scenes.controller.e2e` (com `--runInBand` junto dos outros specs de banco, porque o GC
 * manual olha todas as cenas do banco).
 */
describeIfSceneDb(
  'Cena de template: cancelamento, camadas e retenção (e2e, banco chroma_x_e2e)',
  () => {
    const h = useE2eHarness();
    const { http, authed, post, newScene, waitForScene, isReady } = h;

    describe('cancelamento, camadas e retenção', () => {
      it('cancela durante a chamada: continua ocupada até o worker parar, descarta o resultado e libera', async () => {
        const created = await newScene('E2E Cancelar');
        const sent = await post(`/${created.id}/messages`, {
          content: 'campo #lento',
          expectedRevision: 0,
        });
        const running = await waitForScene(
          created.id,
          (s) => s.activeVersion?.step === 'generating',
        );

        const cancel = await post(`/${created.id}/versions/${sent.body.data.versionId}/cancel`);
        expect(cancel.status).toBe(202);
        expect(cancel.body.data).toMatchObject({
          versionId: sent.body.data.versionId,
          status: 'running',
        });
        const blocked = await post(`/${created.id}/messages`, {
          content: 'outra',
          expectedRevision: cancel.body.data.revision,
        });
        expect(blocked.body.error.code).toBe('SCENE_BUSY');
        expect(running.activeVersion.cancelRequested).toBe(false);

        const done = await waitForScene(created.id, (s) => s.activeVersion === null);
        expect(done.currentVersion).toBeNull();
        expect(done.versions.items[0]).toMatchObject({ status: 'cancelled', previewUrl: null });
        expect(done.messages.at(-1).content).toBe('Geração cancelada.');
        const again = await post(`/${created.id}/messages`, {
          content: 'campo verde',
          expectedRevision: done.revision,
        });
        expect(again.status).toBe(202);
        await waitForScene(created.id, isReady);
      });

      it('logo por upload + PATCH das camadas: uma só versão manual aberta acumula os ajustes', async () => {
        const created = await newScene('E2E Camadas');
        await post(`/${created.id}/messages`, { content: 'campo verde', expectedRevision: 0 });
        const ready = await waitForScene(created.id, isReady);

        const png = await sharp({
          create: { width: 30, height: 30, channels: 4, background: '#f00' },
        })
          .png()
          .toBuffer();
        const logo = await authed(
          http().post(`/v1/template-scenes/${created.id}/assets/logo`),
        ).attach('file', png, {
          filename: 'logo.png',
          contentType: 'image/png',
        });
        expect(logo.status).toBe(201);
        expect(logo.body.data).toMatchObject({ width: 30, height: 30 });

        const element = (extra: object) => ({
          id: 'logo-1',
          kind: 'logo',
          name: 'Logo',
          x: 0.5,
          y: 0.1,
          w: 0.2,
          aspect: 1,
          rotation: 0,
          z: 1,
          assetId: logo.body.data.assetId,
          ...extra,
        });
        const first = await authed(http().patch(`/v1/template-scenes/${created.id}/elements`)).send(
          {
            expectedRevision: ready.revision,
            elements: [element({ x: 0.3 })],
          },
        );
        expect(first.status).toBe(200);
        const second = await authed(
          http().patch(`/v1/template-scenes/${created.id}/elements`),
        ).send({
          expectedRevision: first.body.data.revision,
          elements: [element({ x: 0.3, rotation: 5 })],
        });
        expect(second.body.data.versions.total).toBe(2);
        expect(second.body.data.currentVersion).toMatchObject({
          operation: 'manual',
          isOpenManual: true,
        });
        expect(second.body.data.currentVersion.assets.map((a: { role: string }) => a.role)).toEqual(
          expect.arrayContaining(['master', 'logo']),
        );

        const svg = await authed(
          http().post(`/v1/template-scenes/${created.id}/assets/logo`),
        ).attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
          filename: 'logo.svg',
          contentType: 'image/svg+xml',
        });
        expect(svg.status).toBe(422);
        expect(svg.body.error.code).toBe('LOGO_INVALID');
        const url = await authed(http().patch(`/v1/template-scenes/${created.id}/elements`)).send({
          expectedRevision: second.body.data.revision,
          elements: [{ ...element({}), src: 'http://x/a.png' }],
        });
        expect(url.status).toBe(400);
      });

      it('logo antes de existir imagem: 422 NO_CURRENT_VERSION e nada é gravado', async () => {
        const created = await newScene('E2E Logo sem imagem');
        const png = await sharp({
          create: { width: 8, height: 8, channels: 4, background: '#00f' },
        })
          .png()
          .toBuffer();
        const response = await authed(
          http().post(`/v1/template-scenes/${created.id}/assets/logo`),
        ).attach('file', png, { filename: 'logo.png', contentType: 'image/png' });
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('NO_CURRENT_VERSION');
      });

      it('restaurar e, depois do GC manual, 410 para a versão podada', async () => {
        const scene = await insertScene(h.dataSource, { name: 'E2E Restaurar' });
        h.trackScene(scene.id);
        const files = new SceneFilesService(new ConfigService({ UPLOAD_DEST: h.uploadsDir }));
        const ready = [];
        for (let number = 1; number <= 6; number++) {
          const item = await insertReadyVersion(h.dataSource, scene, number);
          for (const asset of [item.master, item.preview]) {
            const name = path.basename(asset.url);
            await files.write(scene.id, item.version.id, name, Buffer.from(name));
          }
          ready.push(item);
        }
        await h.dataSource.manager.update(
          TemplateScene,
          { id: scene.id },
          { currentVersionId: ready[5].version.id },
        );
        await h.dataSource.query(
          `UPDATE template_scene_assets SET "expiresAt" = now() - interval '1 minute' WHERE "versionId" = $1`,
          [ready[0].version.id],
        );

        const gc = await http()
          .post('/v1/template-scenes/admin/gc')
          .set('x-admin-token', E2E_ADMIN_TOKEN)
          .send({ dryRun: false });
        expect(gc.status).toBe(200);
        expect(gc.body.data).toMatchObject({ dryRun: false });
        expect(gc.body.data.files).toEqual(
          expect.arrayContaining([ready[0].master.url, ready[0].preview.url]),
        );
        await expect(fs.access(files.absolutePath(ready[0].master.url))).rejects.toThrow();

        const gone = await post(`/${scene.id}/versions/${ready[0].version.id}/restore`);
        expect(gone.status).toBe(410);
        expect(gone.body.error).toMatchObject({
          code: 'VERSION_NOT_RESTORABLE',
          details: { reason: 'master_purged' },
        });
        const ok = await post(`/${scene.id}/versions/${ready[2].version.id}/restore`);
        expect(ok.status).toBe(200);
        expect(ok.body.data.currentVersion).toMatchObject({ operation: 'restore', number: 7 });
        expect(
          ok.body.data.versions.items.find((v: { number: number }) => v.number === 1),
        ).toMatchObject({
          restorable: false,
          previewUrl: null,
        });
      });
    });
  },
);
