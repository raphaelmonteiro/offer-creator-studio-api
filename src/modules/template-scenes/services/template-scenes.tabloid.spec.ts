import { QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { insertVersion } from '../testing/scene-fixtures';
import { useFacesHarness } from '../testing/scene-faces-harness';
import { describeIfSceneDb } from '../testing/scene-test-db';
import { errorBodyOf, errorOf } from '../testing/scene-test-helpers';
import { SceneFacesService } from './scene-faces.service';
import { setFaceCurrentVersion } from './scene-faces';
import { SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { SceneTurnService } from './scene-turn.service';
import { TemplateScenesService } from './template-scenes.service';

describeIfSceneDb('Jornal: criação, leitura e derivação (banco chroma_x_e2e)', () => {
  const h = useFacesHarness();
  const locks = () => new SceneLockService(h.dataSource);
  const scenes = () =>
    new TemplateScenesService(h.dataSource, locks(), new SceneReadService(h.dataSource));
  const faces = () =>
    new SceneFacesService(
      h.dataSource,
      locks(),
      h.queue as unknown as ConstructorParameters<typeof SceneFacesService>[2],
    );
  const create = async (name: string, formatId: string, layout?: 'single' | 'tabloid') => {
    const detail = await scenes().create({ name, formatId, layout }, null);
    h.trackScene(detail.id);
    return detail;
  };

  describe('Criar cena de jornal', () => {
    it('Cena de jornal: duas faces na mesma transação, 3328x2480, sem versão, com a dobra', async () => {
      const detail = await create('Aniversário', 'folheto-54x40', 'tabloid');

      expect(detail).toMatchObject({ layout: 'tabloid', widthPx: 3328, heightPx: 2480 });
      expect(detail.faces.map((face) => [face.index, face.key, face.label])).toEqual([
        [0, 'outer', 'Externa'],
        [1, 'inner', 'Interna'],
      ]);
      expect(detail.faces.every((face) => face.currentVersion === null)).toBe(true);
      const [outer, inner] = detail.faces;
      expect(outer.zones.header.x).toBeCloseTo(0.535, 3);
      expect(outer.zones.header.h).toBeCloseTo(0.15, 10);
      expect(outer.zones.footer).toMatchObject({ x: 0, y: 0.9 });
      expect(outer.zones.fold?.x).toBeCloseTo(0.47296, 4);
      expect(inner.zones.header.h).toBe(0);
      expect(inner.zones.footer.h).toBe(0);
      expect(inner.zones.fold).toEqual(outer.zones.fold);
      expect(detail.zones).toEqual(outer.zones);
    });

    it('Jornal em outro formato: 422 SCENE_LAYOUT_UNSUPPORTED e nada é gravado', async () => {
      const name = `Jornal 27x40 ${Date.now()}`;
      const body = await errorBodyOf(
        scenes().create({ name, formatId: 'folheto-27x40', layout: 'tabloid' }, null),
      );
      expect(body).toMatchObject({
        code: 'SCENE_LAYOUT_UNSUPPORTED',
        details: { formatId: 'folheto-27x40', layout: 'tabloid' },
      });
      expect(await h.dataSource.manager.countBy(TemplateScene, { name })).toBe(0);
    });

    it('54x40 de uma face como hoje: layout single, uma face, sem dobra', async () => {
      const detail = await create('Uma face 54x40', 'folheto-54x40');
      expect(detail.layout).toBe('single');
      expect(detail.faces).toHaveLength(1);
      expect(detail.faces[0].zones.fold).toBeUndefined();
      expect(detail.faces[0].zones.header).toMatchObject({ x: 0, w: 1 });
    });

    it('Face de outro layout: 422 FACE_NOT_FOUND na mensagem e nada é gravado', async () => {
      const detail = await create('Face errada', 'folheto-54x40', 'tabloid');
      const turns = new SceneTurnService(h.dataSource, locks(), h.queue as never);
      for (const face of ['back', 'front', 'single']) {
        const result = await errorOf(
          turns.sendMessage(detail.id, { content: 'oi', expectedRevision: 0, face } as never, null),
        );
        expect(result).toEqual({ status: 422, code: 'FACE_NOT_FOUND' });
      }
      expect(await h.dataSource.manager.countBy(TemplateSceneVersion, { sceneId: detail.id })).toBe(
        0,
      );
    });

    it('GET /:id?face=inner traz a página de versões da Interna', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const detail = await scenes().get(scene.id, 1, 'inner');
      expect(detail.versions.items.every((version) => version.faceKey === 'inner')).toBe(true);
      expect(detail.versions.items).toHaveLength(1);
    });
  });

  describe('Rota de derivar generalizada', () => {
    it('inner na cena de jornal: 202, versão derive_face na Interna e mensagem "Fazer a interna"', async () => {
      const { scene, outer } = await h.tabloidScene({ outer: true });
      const revision = (await h.sceneOf(scene.id)).revision;

      const result = await faces().deriveFace(scene.id, 'inner', {
        expectedRevision: revision,
        userId: null,
      });

      expect(await h.versionOf(result.versionId)).toMatchObject({
        faceIndex: 1,
        operation: 'derive_face',
        status: 'queued',
        derivedFromVersionId: outer?.id,
      });
      const jobs = h.queue.publish.mock.calls.filter(([n]) => n === QUEUES.TEMPLATE_SCENE_TURN);
      expect(jobs).toHaveLength(1);
      const message = await h.dataSource.query(
        `SELECT content, "faceIndex" FROM template_scene_messages WHERE id = $1`,
        [result.messageId],
      );
      expect(message[0]).toEqual({ content: 'Fazer a interna', faceIndex: 1 });
    });

    it('Externa sem imagem: 422 FRONT_NOT_READY com details.faceKey inner', async () => {
      const { scene } = await h.tabloidScene();
      const body = await errorBodyOf(
        faces().deriveFace(scene.id, 'inner', { expectedRevision: 0, userId: null }),
      );
      expect(body).toMatchObject({ code: 'FRONT_NOT_READY', details: { faceKey: 'inner' } });
    });

    it('Interna já existe: 409 BACK_ALREADY_EXISTS com details.faceKey inner', async () => {
      const { scene } = await h.tabloidScene({ outer: true, inner: true });
      const body = await errorBodyOf(
        faces().deriveFace(scene.id, 'inner', { expectedRevision: 0, userId: null }),
      );
      expect(body).toMatchObject({ code: 'BACK_ALREADY_EXISTS', details: { faceKey: 'inner' } });
    });

    it('Derivar a interna em cena de frente e verso, e o verso no jornal: 422 FACE_NOT_FOUND', async () => {
      const fb = await h.frontBackScene({ front: true });
      const tb = await h.tabloidScene({ outer: true });
      const inner = await errorOf(
        faces().deriveFace(fb.scene.id, 'inner', { expectedRevision: 0, userId: null }),
      );
      const back = await errorOf(
        faces().deriveFace(tb.scene.id, 'back', { expectedRevision: 0, userId: null }),
      );
      const other = await errorOf(
        faces().deriveFace(tb.scene.id, 'outer', { expectedRevision: 0, userId: null }),
      );
      expect([inner, back, other]).toEqual(Array(3).fill({ status: 422, code: 'FACE_NOT_FOUND' }));
    });

    it('Clique duplo e cena ocupada', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const revision = (await h.sceneOf(scene.id)).revision;
      const outcomes = await Promise.allSettled([
        faces().deriveFace(scene.id, 'inner', { expectedRevision: revision, userId: null }),
        faces().deriveFace(scene.id, 'inner', { expectedRevision: revision, userId: null }),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(
        await h.dataSource.manager.countBy(TemplateSceneVersion, {
          sceneId: scene.id,
          faceIndex: 1,
        }),
      ).toBe(1);
      const busy = await errorOf(
        faces().deriveFace(scene.id, 'inner', { expectedRevision: revision + 1, userId: null }),
      );
      expect(busy).toEqual({ status: 409, code: 'SCENE_BUSY' });
    });
  });

  describe('Zonas por versão (PV-T10)', () => {
    it('a face adota as zonas da versão que vira a atual; versão sem zonas volta às da criação', async () => {
      const { scene } = await h.tabloidScene({ outer: true });
      const face = () =>
        h.dataSource.manager.findOneByOrFail(TemplateSceneFace, { sceneId: scene.id, index: 0 });
      const wide = await insertVersion(h.dataSource, scene.id, {
        number: 5,
        zones: { ...(await face()).zones, header: { ...(await face()).zones.header, h: 0.2 } },
      });
      const plain = await insertVersion(h.dataSource, scene.id, { number: 6, zones: null });

      await setFaceCurrentVersion(h.dataSource.manager, await h.sceneOf(scene.id), 0, wide.id);
      expect((await face()).zones.header.h).toBeCloseTo(0.2, 10);
      await setFaceCurrentVersion(h.dataSource.manager, await h.sceneOf(scene.id), 0, plain.id);
      expect((await face()).zones.header.h).toBeCloseTo(0.15, 10);
    });

    it('cena que não é jornal: as zonas da face não mudam', async () => {
      const { scene } = await h.frontBackScene({ front: true });
      const before = (
        await h.dataSource.manager.findOneByOrFail(TemplateSceneFace, {
          sceneId: scene.id,
          index: 0,
        })
      ).zones;
      const version = await insertVersion(h.dataSource, scene.id, { number: 9 });
      await setFaceCurrentVersion(h.dataSource.manager, await h.sceneOf(scene.id), 0, version.id);
      const after = (
        await h.dataSource.manager.findOneByOrFail(TemplateSceneFace, {
          sceneId: scene.id,
          index: 0,
        })
      ).zones;
      expect(after).toEqual(before);
    });
  });
});
