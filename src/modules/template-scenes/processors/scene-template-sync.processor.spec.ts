import { SceneElement } from '../domain/scene.types';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneReadService } from '../services/scene-read.service';
import { SceneVersionsService } from '../services/scene-versions.service';
import { pointFace } from '../testing/scene-fixtures';
import { useSyncHarness } from '../testing/scene-template-sync-harness';
import { layer, near, pixelOf, Rgb } from '../testing/scene-template-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { fakeQueue, textElement } from '../testing/scene-test-helpers';

const RED: Rgb = [220, 20, 20];
const GREEN: Rgb = [20, 200, 20];

describeIfSceneDb('SceneTemplateSyncProcessor: fluxo (banco chroma_x_e2e)', () => {
  const h = useSyncHarness();

  describe('Primeira imagem pronta', () => {
    it('cria o template full com o nome e o formato da cena, o marcador e o ponteiro da cena', async () => {
      const { scene, version } = await h.readySmall();

      await h.sync(scene.id);

      const template = await h.templateOf(scene.id);
      expect(template).toMatchObject({ name: 'Processor edição', type: 'full', isDefault: false });
      expect(template.config.format).toBe('folheto-27x54');
      expect(template.config.source).toMatchObject({
        kind: 'template-scene',
        sceneId: scene.id,
        versionId: version.id,
        sceneRevision: 0,
        projectionVersion: 1,
      });
      expect(template.thumbnailUrl).toMatch(/\/thumbnail\.jpg$/);
      const stored = await h.sceneRow(scene.id);
      expect(stored.approvedTemplateId).toBe(template.id);
      expect(stored.approvedAt).not.toBeNull();
      expect(stored.revision).toBe(0);
      for (const url of [
        template.config.bodyBackground.imageUrl,
        template.config.header.background.imageUrl,
        template.config.footer.background.imageUrl,
        template.thumbnailUrl as string,
      ]) {
        await expect(h.fileOfUrl(url)).resolves.toBeInstanceOf(Buffer);
      }
    });

    it('não grava approvedAt na versão (a master segue na retenção das cenas)', async () => {
      const { scene, version } = await h.readySmall();
      await h.sync(scene.id);
      expect((await h.versionOf(version.id)).approvedAt).toBeNull();
    });
  });

  describe('Cena sem imagem', () => {
    it('sem versão atual: nada é criado e o job não falha', async () => {
      const { scene } = await h.queuedScene('ainda gerando');
      await expect(h.sync(scene.id)).resolves.toBeUndefined();
      expect(await h.templatesOf(scene.id)).toEqual([]);
    });

    it('versão atual que não está ready: sem template', async () => {
      const { scene, version } = await h.queuedScene('falhou');
      await h.dataSource.query(
        `UPDATE template_scene_versions SET status = 'failed' WHERE id = $1`,
        [version.id],
      );
      await pointFace(h.dataSource, scene, version.id);
      await h.sync(scene.id);
      expect(await h.templatesOf(scene.id)).toEqual([]);
    });

    it('cena que não existe: encerra sem erro', async () => {
      await expect(h.sync('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
    });
  });

  describe('Imagem nova atualiza o template', () => {
    it('as imagens apontam para arquivos novos, os antigos ficam e o snapshot do encarte continua válido', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const before = await h.templateOf(scene.id);
      const snapshot = JSON.parse(JSON.stringify(before.config)); // o que o encarte guardou
      const oldFiles = await h.filesOf(scene.id);

      const v2 = await h.newImageVersion(scene, 2, RED);
      await h.sync(scene.id);

      const after = await h.templateOf(scene.id);
      expect(after.id).toBe(before.id);
      expect(after.config.source.versionId).toBe(v2.id);
      expect(after.config.bodyBackground.imageUrl).not.toBe(before.config.bodyBackground.imageUrl);
      expect(after.config.header.background.imageUrl).not.toBe(
        before.config.header.background.imageUrl,
      );
      expect(after.thumbnailUrl).not.toBe(before.thumbnailUrl);
      expect(
        near(await pixelOf(await h.fileOfUrl(after.config.bodyBackground.imageUrl), 50, 300), RED),
      ).toBe(true);
      const files = await h.filesOf(scene.id);
      expect(files).toEqual(expect.arrayContaining(oldFiles));
      expect(files.length).toBe(oldFiles.length * 2);
      await expect(h.fileOfUrl(snapshot.bodyBackground.imageUrl)).resolves.toBeInstanceOf(Buffer);
      expect(await h.templatesOf(scene.id)).toHaveLength(1);
    });
  });

  describe('Voltar para versão antiga', () => {
    it('o template passa a mostrar a imagem da versão antiga', async () => {
      const { scene, version: v1 } = await h.readySmall();
      await h.newImageVersion(scene, 2, RED);
      await h.sync(scene.id);
      const withV2 = await h.templateOf(scene.id);
      expect(
        near(await pixelOf(await h.fileOfUrl(withV2.config.bodyBackground.imageUrl), 50, 300), RED),
      ).toBe(true);

      await h.makeCurrent(scene.id, v1.id);
      await h.sync(scene.id);

      const back = await h.templateOf(scene.id);
      expect(back.config.source.versionId).toBe(v1.id);
      expect(back.config.source.pictorialKey).not.toBe(withV2.config.source.pictorialKey);
      expect(
        near(await pixelOf(await h.fileOfUrl(back.config.bodyBackground.imageUrl), 50, 300), RED),
      ).toBe(false);
    });
  });

  describe('Ajuste só de camada', () => {
    it('a logo vai para a posição final, as URLs das imagens não mudam e nenhuma imagem nova é gravada', async () => {
      const { scene, version } = await h.readySmall();
      const logo = await h.addLogoAsset(scene, version);
      const element = (x: number): SceneElement =>
        layer({
          id: 'logo-1',
          kind: 'logo',
          name: 'Logo',
          assetId: logo.id,
          x,
          y: 0.05,
          w: 0.3,
          aspect: 2,
          z: 1,
        });
      await h.setElements(version.id, [element(0.2)]);
      await h.bumpRevision(scene.id);
      await h.sync(scene.id);
      const first = await h.templateOf(scene.id);
      const filesBefore = await h.filesOf(scene.id);

      for (const x of [0.3, 0.6, 0.8]) {
        await h.setElements(version.id, [element(x)]);
        await h.bumpRevision(scene.id);
      }
      await h.sync(scene.id);

      const after = await h.templateOf(scene.id);
      expect(after.config.header.elements).toHaveLength(1);
      expect(after.config.header.elements[0].x).toBeCloseTo(0.8 * 780 - 0.15 * 780, 1);
      expect(after.config.bodyBackground.imageUrl).toBe(first.config.bodyBackground.imageUrl);
      expect(after.config.header.background.imageUrl).toBe(first.config.header.background.imageUrl);
      expect(after.thumbnailUrl).toBe(first.thumbnailUrl);
      expect(await h.filesOf(scene.id)).toEqual(filesBefore);
    });

    it('logo nova é copiada, e o texto vira elemento do rodapé', async () => {
      const { scene, version } = await h.readySmall();
      await h.sync(scene.id);
      const logo = await h.addLogoAsset(scene, version);
      await h.setElements(version.id, [
        layer({ id: 'l', kind: 'logo', name: 'Logo', assetId: logo.id, y: 0.05 }),
        layer({ id: 't', text: 'Ofertas da semana', y: 0.96, w: 0.6, aspect: 5, fontSize: 7 }),
      ]);
      await h.bumpRevision(scene.id);

      await h.sync(scene.id);

      const template = await h.templateOf(scene.id);
      expect(template.config.header.elements).toHaveLength(1);
      expect(template.config.footer.elements[0]).toMatchObject({
        type: 'text',
        content: 'Ofertas da semana',
      });
      expect((await h.filesOf(scene.id)).filter((f) => f.includes('/logos/'))).toHaveLength(1);
    });
  });

  describe('Mensagem sem versão nova', () => {
    it('só a revisão sobe: a configuração visual não muda e nenhum arquivo é gravado', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const before = await h.templateOf(scene.id);
      const files = await h.filesOf(scene.id);

      await h.bumpRevision(scene.id);
      await h.sync(scene.id);

      const after = await h.templateOf(scene.id);
      const visual = ({ header, footer, bodyBackground, format }: typeof before.config) => ({
        header,
        footer,
        bodyBackground,
        format,
      });
      expect(visual(after.config)).toEqual(visual(before.config));
      expect(after.config.source.sceneRevision).toBe(1);
      expect(await h.filesOf(scene.id)).toEqual(files);
    });
  });

  describe('Job repetido', () => {
    it('um só template, nenhum arquivo novo e a configuração igual', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const before = await h.templateOf(scene.id);
      const files = await h.filesOf(scene.id);

      await h.sync(scene.id);
      await h.sync(scene.id);

      expect(await h.templatesOf(scene.id)).toHaveLength(1);
      expect((await h.templateOf(scene.id)).config).toEqual(before.config);
      expect(await h.filesOf(scene.id)).toEqual(files);
    });

    it('template apagado pela API: o job seguinte recria um só, da mesma imagem', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const before = await h.templateOf(scene.id);
      await h.dataSource.query(`DELETE FROM templates WHERE id = $1`, [before.id]);

      await h.sync(scene.id);

      const after = await h.templateOf(scene.id);
      expect(after.id).not.toBe(before.id);
      expect(after.config.source.pictorialKey).toBe(before.config.source.pictorialKey);
      await expect(h.fileOfUrl(after.config.bodyBackground.imageUrl)).resolves.toBeInstanceOf(
        Buffer,
      );
      expect((await h.sceneRow(scene.id)).approvedTemplateId).toBe(after.id);
    });
  });

  describe('Sincronização não atrapalha a edição', () => {
    it('a revisão não sobe, e o ajuste com a mesma expectedRevision é aceito', async () => {
      const { scene } = await h.readySmall();
      await h.bumpRevision(scene.id);
      const revision = (await h.sceneRow(scene.id)).revision;

      await h.sync(scene.id);

      expect((await h.sceneRow(scene.id)).revision).toBe(revision);
      const versions = new SceneVersionsService(
        h.dataSource,
        new SceneLockService(h.dataSource),
        new SceneReadService(h.dataSource),
        fakeQueue().service,
      );
      const detail = await versions.patchElements(
        scene.id,
        { expectedRevision: revision, elements: [textElement('t1')] },
        null,
      );
      expect(detail.revision).toBe(revision + 1);
    });
  });

  it('a imagem da projeção tem as faixas das zonas: o centro do cabeçalho vem da master', async () => {
    const { scene } = await h.readySmall();
    await h.newImageVersion(scene, 2, GREEN);
    await h.sync(scene.id);
    const template = await h.templateOf(scene.id);
    const header = await h.fileOfUrl(template.config.header.background.imageUrl);
    expect(near(await pixelOf(header, 100, 10), GREEN)).toBe(true);
  });
});
