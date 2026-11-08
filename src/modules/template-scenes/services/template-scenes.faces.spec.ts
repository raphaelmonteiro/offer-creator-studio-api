import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import { FRONT_BACK_FORMAT_IDS } from '../domain/scene-faces';
import { CreateSceneDto } from '../dto/create-scene.dto';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneFace } from '../entities/template-scene-face.entity';
import { insertReadyVersion, insertScene, insertVersion } from '../testing/scene-fixtures';
import { errorOf } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { displayNumbersOf } from './scene-display-number';
import { setFaceCurrentVersion } from './scene-faces';
import { SceneLockService } from './scene-lock.service';
import { SceneReadService } from './scene-read.service';
import { TemplateScenesService } from './template-scenes.service';

describeIfSceneDb('Faces da cena: criação e leitura (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let service: TemplateScenesService;
  let reads: SceneReadService;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
    reads = new SceneReadService(dataSource);
    service = new TemplateScenesService(dataSource, new SceneLockService(dataSource), reads);
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
  });

  const create = async (name: string, formatId: string, layout?: 'single' | 'front_back') => {
    const detail = await service.create({ name, formatId, layout }, null);
    createdScenes.push(detail.id);
    return detail;
  };

  describe('Cena de frente e verso', () => {
    it('cria as duas faces na mesma transação, sem versão, com as zonas de cada uma', async () => {
      const detail = await create('São João', 'folheto-27x40', 'front_back');

      expect(detail).toMatchObject({ layout: 'front_back', widthPx: 2352, heightPx: 3504 });
      expect(detail.faces.map((face) => [face.index, face.key, face.label])).toEqual([
        [0, 'front', 'Frente'],
        [1, 'back', 'Verso'],
      ]);
      const [front, back] = detail.faces;
      expect(front.zones.footer.h).toBe(0);
      expect(front.zones.header.h).toBeCloseTo(6 / 40, 6);
      expect(back.zones.header.h).toBe(0);
      expect(back.zones.footer.h).toBeCloseTo(4 / 40, 6);
      expect(back.zones.footer.y).toBeCloseTo(1 - 4 / 40, 6);
      expect(detail.faces.every((face) => face.currentVersion === null)).toBe(true);
      expect(detail.faces.every((face) => face.templateId === null)).toBe(true);
      expect(detail.faces.every((face) => face.widthPx === 2352 && face.heightPx === 3504)).toBe(
        true,
      );
      expect(detail.zones).toEqual(front.zones);
      const rows = await dataSource.manager.findBy(TemplateSceneFace, { sceneId: detail.id });
      expect(rows).toHaveLength(2);
    });

    it.each(FRONT_BACK_FORMAT_IDS)('o formato em retrato %s aceita frente e verso', async (id) => {
      const detail = await create(`FV ${id}`, id, 'front_back');
      expect(detail.layout).toBe('front_back');
      expect(detail.faces).toHaveLength(2);
    });

    it.each(['folheto-55x36', 'folheto-54x40', 'folheto-54x30'])(
      'o formato em paisagem %s não aceita: 422 SCENE_LAYOUT_UNSUPPORTED e nada é gravado',
      async (formatId) => {
        const name = `FV paisagem ${formatId} ${Date.now()}`;
        const result = await errorOf(
          service.create({ name, formatId, layout: 'front_back' }, null),
        );
        expect(result).toEqual({ status: 422, code: 'SCENE_LAYOUT_UNSUPPORTED' });
        expect(await dataSource.manager.countBy(TemplateScene, { name })).toBe(0);
      },
    );

    it('layout desconhecido é 400 na validação do corpo', async () => {
      const dto = plainToInstance(CreateSceneDto, {
        name: 'X',
        formatId: 'folheto-27x40',
        layout: 'tabloide',
      });
      const errors = await validate(dto);
      expect(errors.map((error) => error.property)).toEqual(['layout']);
    });
  });

  describe('Cena de uma face como hoje', () => {
    it('sem layout: single, uma face com as zonas do formato e sem rótulo', async () => {
      const detail = await create('Páscoa', 'folheto-27x54');

      expect(detail.layout).toBe('single');
      expect(detail.faces).toHaveLength(1);
      expect(detail.faces[0]).toMatchObject({ index: 0, key: 'single', label: null });
      expect(detail.faces[0].zones.header.h).toBeCloseTo(6 / 54, 6);
      expect(detail.faces[0].zones.footer.h).toBeCloseTo(4 / 54, 6);
      expect(detail.zones).toEqual(detail.faces[0].zones);
    });

    it('a lista traz o layout de cada cena', async () => {
      const single = await create('Lista single', 'folheto-27x54');
      const both = await create('Lista frente e verso', 'folheto-27x54', 'front_back');
      const { items } = await reads.list(1, 50);
      const layouts = new Map(items.map((item) => [item.id, item.layout]));
      expect(layouts.get(single.id)).toBe('single');
      expect(layouts.get(both.id)).toBe('front_back');
    });
  });

  describe('Faces no detalhe', () => {
    async function frontBackWithFront() {
      const detail = await create('Detalhe FV', 'folheto-27x40', 'front_back');
      const scene = (await dataSource.manager.findOneByOrFail(TemplateScene, {
        id: detail.id,
      })) as TemplateScene;
      const first = await insertReadyVersion(dataSource, scene, 1);
      const second = await insertReadyVersion(dataSource, scene, 2, {
        parentVersionId: first.version.id,
      });
      await dataSource.transaction(async (manager) => {
        await setFaceCurrentVersion(manager, scene, 0, second.version.id);
      });
      return { scene, first: first.version, second: second.version };
    }

    it('a frente na versão 2 e o verso vazio: currentVersion é o da Frente', async () => {
      const { scene, second } = await frontBackWithFront();

      const detail = await reads.loadDetail(scene.id);

      expect(detail.faces[0].currentVersion).toMatchObject({ id: second.id, faceKey: 'front' });
      expect(detail.faces[1].currentVersion).toBeNull();
      expect(detail.currentVersion?.id).toBe(second.id);
    });

    it('?face=back traz a página de versões do verso; face que a cena não tem é 422', async () => {
      const { scene } = await frontBackWithFront();

      const back = await reads.loadDetail(scene.id, 1, undefined, 'back');
      expect(back.versions.items).toEqual([]);

      const single = await create('Detalhe single', 'folheto-27x54');
      const result = await errorOf(reads.loadDetail(single.id, 1, undefined, 'back'));
      expect(result).toEqual({ status: 422, code: 'FACE_NOT_FOUND' });
    });
  });

  describe('Números por face', () => {
    it('a frente com 3 versões e o verso com 2: cada face conta a partir de 1 e o painel só lista a dela', async () => {
      const detail = await create('Números FV', 'folheto-27x40', 'front_back');
      const scene = await dataSource.manager.findOneByOrFail(TemplateScene, { id: detail.id });
      const f1 = await insertReadyVersion(dataSource, scene, 1);
      const b1 = await insertReadyVersion(dataSource, scene, 2, { faceIndex: 1 });
      const f2 = await insertReadyVersion(dataSource, scene, 3, { parentVersionId: f1.version.id });
      const b2 = await insertReadyVersion(dataSource, scene, 4, {
        faceIndex: 1,
        parentVersionId: b1.version.id,
      });
      const f3 = await insertReadyVersion(dataSource, scene, 5, { parentVersionId: f2.version.id });
      await insertVersion(dataSource, scene.id, { number: 6, status: 'rejected' });
      await dataSource.transaction(async (manager) => {
        await setFaceCurrentVersion(manager, scene, 0, f3.version.id);
        await setFaceCurrentVersion(manager, scene, 1, b2.version.id);
      });

      const numbers = await displayNumbersOf(dataSource.manager, scene.id);
      expect(numbers.get(f3.version.id)).toBe(3);
      expect(numbers.get(b1.version.id)).toBe(1);
      expect(numbers.get(b2.version.id)).toBe(2);

      const back = await reads.loadDetail(scene.id, 1, undefined, 'back');
      expect(back.versions.items.map((v) => [v.number, v.displayNumber, v.faceKey])).toEqual([
        [4, 2, 'back'],
        [2, 1, 'back'],
      ]);
      const front = await reads.loadDetail(scene.id);
      expect(front.versions.items.map((v) => v.displayNumber)).toEqual([3, 2, 1]);
      expect(front.versions.total).toBe(3);
    });
  });

  describe('Espelho da face 0', () => {
    it('versão nova no verso não muda o espelho; a da frente muda', async () => {
      const scene = await insertScene(dataSource, { name: 'Espelho', layout: 'front_back' });
      createdScenes.push(scene.id);
      const front = await insertReadyVersion(dataSource, scene, 1);
      const back = await insertReadyVersion(dataSource, scene, 2, { faceIndex: 1 });

      await dataSource.transaction(async (manager) => {
        await setFaceCurrentVersion(manager, scene, 0, front.version.id);
        await setFaceCurrentVersion(manager, scene, 1, back.version.id);
      });

      const stored = await dataSource.manager.findOneByOrFail(TemplateScene, { id: scene.id });
      expect(stored.currentVersionId).toBe(front.version.id);
      const faces = await dataSource.manager.find(TemplateSceneFace, {
        where: { sceneId: scene.id },
        order: { index: 'ASC' },
      });
      expect(faces.map((face) => face.currentVersionId)).toEqual([
        front.version.id,
        back.version.id,
      ]);
    });
  });
});
