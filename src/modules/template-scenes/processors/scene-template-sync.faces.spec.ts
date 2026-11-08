import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { Template } from '../../templates/entities/template.entity';
import { SceneTemplateConfiguration } from '../domain/scene-template.types';
import { SceneLockService } from '../services/scene-lock.service';
import { SceneReadService } from '../services/scene-read.service';
import { SceneTemplateSweepService } from '../services/scene-template-sweep.service';
import { TemplateScenesService } from '../services/template-scenes.service';
import { insertScene, pointFace } from '../testing/scene-fixtures';
import { CDN, useSyncHarness } from '../testing/scene-template-sync-harness';
import { solidPng } from '../testing/scene-template-fixtures';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { fakeQueue } from '../testing/scene-test-helpers';

type Config = SceneTemplateConfiguration;
const WIDTH = 384;
const HEIGHT = 576;
const BLUE: [number, number, number] = [20, 20, 220];
const GREEN: [number, number, number] = [20, 200, 20];
const ORANGE: [number, number, number] = [240, 140, 20];

describeIfSceneDb('Template por face: frente e verso (banco chroma_x_e2e)', () => {
  const h = useSyncHarness();

  const faceRows = (sceneId: string) =>
    h.dataSource.manager.find(TemplateSceneFace, { where: { sceneId }, order: { index: 'ASC' } });
  const templatesNamed = async (sceneId: string) =>
    (await h.templatesOf(sceneId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((template) => Object.assign(template, { config: template.configuration as Config }));
  const bodyUrl = (template: { config: Config }) => template.config.bodyBackground.imageUrl;

  async function frontBack(name = 'São João') {
    const scene = await insertScene(h.dataSource, {
      name,
      layout: 'front_back',
      formatId: 'folheto-27x40',
      artWidthCm: 27.5,
      artHeightCm: 41,
      widthPx: WIDTH,
      heightPx: HEIGHT,
    });
    h.trackScene(scene.id);
    return scene;
  }

  /** Versão `ready` da face, com master de cor sólida, apontada como a atual da face (a `revision` sobe, como no fluxo real). */
  async function readyFace(
    scene: TemplateScene,
    face: {
      index: number;
      number: number;
      color: [number, number, number];
      parent?: string | null;
    },
  ) {
    const made = await h.readyVersionLike(
      scene,
      face.number,
      face.parent ?? null,
      await solidPng(WIDTH, HEIGHT, face.color),
      [],
      { faceIndex: face.index },
    );
    await pointFace(h.dataSource, scene, made.version.id, face.index);
    await h.bumpRevision(scene.id);
    return made.version;
  }

  describe('Frente pronta, verso vazio', () => {
    it('existe só o template "São João — Frente", e nenhum do verso', async () => {
      const scene = await frontBack();
      const front = await readyFace(scene, { index: 0, number: 1, color: BLUE });

      await h.sync(scene.id);

      const templates = await templatesNamed(scene.id);
      expect(templates.map((template) => template.name)).toEqual(['São João — Frente']);
      expect(templates[0].config.source).toMatchObject({
        kind: 'template-scene',
        sceneId: scene.id,
        faceKey: 'front',
        faceIndex: 0,
        versionId: front.id,
      });
      const [frontFace, backFace] = await faceRows(scene.id);
      expect(frontFace.templateId).toBe(templates[0].id);
      expect(backFace.templateId).toBeNull();
      expect((await h.sceneRow(scene.id)).approvedTemplateId).toBe(templates[0].id);
    });
  });

  describe('Verso pronto', () => {
    it('o template "São João — Verso" aparece, com source.faceKey back, e os dois ficam lado a lado', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await h.sync(scene.id);
      const back = await readyFace(scene, { index: 1, number: 2, color: GREEN });

      await h.sync(scene.id);

      const templates = await templatesNamed(scene.id);
      expect(templates.map((template) => template.name)).toEqual([
        'São João — Frente',
        'São João — Verso',
      ]);
      expect(templates[1].config.source).toMatchObject({
        sceneId: scene.id,
        faceKey: 'back',
        faceIndex: 1,
        versionId: back.id,
      });
      const [frontFace, backFace] = await faceRows(scene.id);
      expect([frontFace.templateId, backFace.templateId]).toEqual(templates.map((t) => t.id));
      // o espelho é o da face 0
      expect((await h.sceneRow(scene.id)).approvedTemplateId).toBe(frontFace.templateId);
      expect(new Set(templates.map((template) => template.id)).size).toBe(2);
    });
  });

  describe('Seções da frente e do verso', () => {
    it('a frente tem rodapé de altura 0 e o verso tem cabeçalho de altura 0; o fundo é a imagem inteira da face', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await readyFace(scene, { index: 1, number: 2, color: GREEN });

      await h.sync(scene.id);

      const [front, back] = await templatesNamed(scene.id);
      expect(front.config.header.heightCm).toBeCloseTo((6 / 40) * 41, 4);
      expect(front.config.header.background.type).toBe('image');
      expect(front.config.footer).toMatchObject({
        heightCm: 0,
        background: { type: 'solid', color: 'transparent' },
        elements: [],
      });
      expect(back.config.header).toMatchObject({
        heightCm: 0,
        background: { type: 'solid', color: 'transparent' },
        elements: [],
      });
      expect(back.config.footer.heightCm).toBeCloseTo((4 / 40) * 41, 4);
      expect(back.config.footer.background.type).toBe('image');
      for (const template of [front, back]) {
        expect(template.config.format).toBe('folheto-27x40');
        expect(template.config.bodyBackground.imageUrl).toContain(
          `${CDN}/templates/scene-${scene.id}/`,
        );
        expect(template.config.header.widthCm).toBe(27.5);
      }
      // sem fatia de imagem na seção de altura 0
      const files = (await h.filesOf(scene.id)).map((file) => file.split('/').pop());
      expect(files.filter((name) => name === 'full.jpg')).toHaveLength(2);
      expect(files.filter((name) => name === 'header.jpg')).toHaveLength(1);
      expect(files.filter((name) => name === 'footer.jpg')).toHaveLength(1);
    });

    it('texto no cabeçalho da frente vira elemento do cabeçalho; o que cai na zona que a face não tem (rodapé) fica fora', async () => {
      const scene = await frontBack();
      const front = await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await h.setElements(front.id, [
        {
          id: 'topo',
          kind: 'text',
          name: 'Título',
          x: 0.5,
          y: 0.05,
          w: 0.6,
          aspect: 5,
          rotation: 0,
          z: 1,
          text: 'Ofertas de São João',
          fontSize: 6,
        },
        {
          id: 'baixo',
          kind: 'text',
          name: 'Rodapé',
          x: 0.5,
          y: 0.97,
          w: 0.6,
          aspect: 5,
          rotation: 0,
          z: 2,
          text: 'Não existe rodapé na frente',
          fontSize: 6,
        },
      ]);
      await h.bumpRevision(scene.id);

      await h.sync(scene.id);

      const [template] = await templatesNamed(scene.id);
      expect(template.config.header.elements).toHaveLength(1);
      expect(template.config.header.elements[0]).toMatchObject({ content: 'Ofertas de São João' });
      expect(template.config.footer.elements).toEqual([]);
    });
  });

  describe('Mudança só no verso', () => {
    it('as imagens do template do Verso apontam para arquivos novos e as da Frente não mudam', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      const back1 = await readyFace(scene, { index: 1, number: 2, color: GREEN });
      await h.sync(scene.id);
      const [frontBefore, backBefore] = await templatesNamed(scene.id);

      await readyFace(scene, { index: 1, number: 3, color: ORANGE, parent: back1.id });
      await h.sync(scene.id);

      const [frontAfter, backAfter] = await templatesNamed(scene.id);
      expect(frontAfter.id).toBe(frontBefore.id);
      expect(backAfter.id).toBe(backBefore.id);
      expect(bodyUrl(frontAfter)).toBe(bodyUrl(frontBefore));
      expect(frontAfter.config.header.background.imageUrl).toBe(
        frontBefore.config.header.background.imageUrl,
      );
      expect(bodyUrl(backAfter)).not.toBe(bodyUrl(backBefore));
      expect(backAfter.config.footer.background.imageUrl).not.toBe(
        backBefore.config.footer.background.imageUrl,
      );
      // a Frente só teve a revisão e a versão atualizadas (touch)
      expect(frontAfter.config.source.sceneRevision).toBeGreaterThan(
        frontBefore.config.source.sceneRevision,
      );
    });
  });

  describe('Excluir a cena', () => {
    const service = () =>
      new TemplateScenesService(
        h.dataSource,
        new SceneLockService(h.dataSource),
        new SceneReadService(h.dataSource),
      );

    it('Excluir a cena de frente e verso: os dois templates somem na mesma transação e os arquivos ficam', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await readyFace(scene, { index: 1, number: 2, color: GREEN });
      await h.sync(scene.id);
      const ids = (await templatesNamed(scene.id)).map((template) => template.id);
      const filesBefore = await h.filesOf(scene.id);
      expect(ids).toHaveLength(2);

      await service().remove(scene.id);

      expect(
        await h.dataSource.manager.findBy(
          Template,
          ids.map((id) => ({ id })),
        ),
      ).toEqual([]);
      expect(await h.templatesOf(scene.id)).toEqual([]);
      expect(await h.filesOf(scene.id)).toEqual(filesBefore);
      expect((await faceRows(scene.id)).map((face) => face.templateId)).toEqual([null, null]);
      expect(
        (
          await h.dataSource.manager.findOneOrFail(TemplateScene, {
            where: { id: scene.id },
            withDeleted: true,
          })
        ).approvedTemplateId,
      ).toBeNull();
    });

    it('Excluir com o verso vazio: o template da Frente some e nenhum erro é registrado pela falta do do Verso', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await h.sync(scene.id);
      expect(await h.templatesOf(scene.id)).toHaveLength(1);

      await expect(service().remove(scene.id)).resolves.toBeUndefined();

      expect(await h.templatesOf(scene.id)).toEqual([]);
    });
  });

  describe('Template antigo sem face', () => {
    /** Tira `faceKey` e `faceIndex` do marcador: o template como a change anterior o gravou. */
    async function strip(sceneId: string) {
      const [template] = await h.templatesOf(sceneId);
      const config = template.configuration as Config;
      const { faceKey: _key, faceIndex: _index, ...source } = config.source;
      await h.dataSource.manager.update(
        Template,
        { id: template.id },
        { configuration: { ...config, source } as never },
      );
      return template;
    }

    it('a varredura e o job tratam o template como o da face 0: mesmo template, mesmas URLs, o marcador ganha a face', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const before = await strip(scene.id);
      const urlsBefore = {
        body: (before.configuration as Config).bodyBackground.imageUrl,
        header: (before.configuration as Config).header.background.imageUrl,
      };
      await h.bumpRevision(scene.id);

      await h.sync(scene.id);

      const templates = await h.templatesOf(scene.id);
      expect(templates).toHaveLength(1);
      expect(templates[0].id).toBe(before.id);
      const config = templates[0].configuration as Config;
      expect(config.bodyBackground.imageUrl).toBe(urlsBefore.body);
      expect(config.header.background.imageUrl).toBe(urlsBefore.header);
      expect(config.source).toMatchObject({ faceKey: 'single', faceIndex: 0 });
    });

    it('espelho da face ainda sem o template (migration refeita): o job reconhece o template pela cena, sem criar outro', async () => {
      const { scene } = await h.readySmall();
      await h.sync(scene.id);
      const before = await strip(scene.id);
      await h.dataSource.manager.update(
        TemplateSceneFace,
        { sceneId: scene.id, index: 0 },
        { templateId: null },
      );
      await h.bumpRevision(scene.id);

      await h.sync(scene.id);

      const templates = await h.templatesOf(scene.id);
      expect(templates.map((template) => template.id)).toEqual([before.id]);
      expect((await faceRows(scene.id))[0].templateId).toBe(before.id);
    });
  });

  describe('Varredura por face', () => {
    let queue: ReturnType<typeof fakeQueue>;
    let sweep: SceneTemplateSweepService;
    beforeEach(() => {
      queue = fakeQueue();
      sweep = new SceneTemplateSweepService(h.dataSource, queue.service);
    });
    const queuedIds = () =>
      queue.publish.mock.calls
        .filter(([name]) => name === QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC)
        .map(([, data]) => (data as { sceneId: string }).sceneId);
    const oldest = (sceneId: string) =>
      h.dataSource.query(`UPDATE template_scenes SET "createdAt" = '1999-01-01' WHERE id = $1`, [
        sceneId,
      ]);

    it('a cena com o verso pronto e sem template é escolhida; em dia, não volta', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await h.sync(scene.id);
      await readyFace(scene, { index: 1, number: 2, color: GREEN });
      await oldest(scene.id);

      await sweep.sweep(50);
      expect(queuedIds()).toContain(scene.id);

      await h.sync(scene.id);
      queue.publish.mockClear();
      await sweep.sweep(50);
      expect(queuedIds()).not.toContain(scene.id);
    });

    it('cena só com frente pronta e já sincronizada não é escolhida por causa do verso vazio', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await h.sync(scene.id);
      await oldest(scene.id);

      await sweep.sweep(50);

      expect(queuedIds()).not.toContain(scene.id);
    });

    it('exclusão que escapou: apaga o template de cada face da cena excluída', async () => {
      const scene = await frontBack();
      await readyFace(scene, { index: 0, number: 1, color: BLUE });
      await readyFace(scene, { index: 1, number: 2, color: GREEN });
      await h.sync(scene.id);
      await h.dataSource.query(`UPDATE template_scenes SET "deletedAt" = now() WHERE id = $1`, [
        scene.id,
      ]);

      const result = await sweep.sweep(50);

      expect(result.removed).toBeGreaterThanOrEqual(2);
      expect(await h.templatesOf(scene.id)).toEqual([]);
      expect((await faceRows(scene.id)).map((face) => face.templateId)).toEqual([null, null]);
    });
  });

  it('a falha de uma face não impede a sincronização da outra', async () => {
    const scene = await frontBack();
    await readyFace(scene, { index: 0, number: 1, color: BLUE });
    const back = await readyFace(scene, { index: 1, number: 2, color: GREEN });
    // a master do verso some do disco: a projeção do verso falha, a da frente segue
    await h.dataSource.query(`UPDATE template_scene_assets SET "purgedAt" = now() WHERE id = $1`, [
      back.masterAssetId,
    ]);

    await expect(h.sync(scene.id)).rejects.toThrow();

    expect((await templatesNamed(scene.id)).map((template) => template.name)).toEqual([
      'São João — Frente',
    ]);
    const stored = await h.dataSource.manager.findOneByOrFail(TemplateSceneVersion, {
      id: back.id,
    });
    expect(stored.metrics.templateSync).toMatchObject({ attempts: 1 });
  });
});
