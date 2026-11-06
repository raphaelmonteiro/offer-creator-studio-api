import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { TEMPLATE_SCENE_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import {
  insertAsset,
  insertReadyVersion,
  insertScene,
  insertVersion,
} from '../testing/scene-fixtures';
import { errorOf } from '../testing/scene-test-helpers';
import {
  deleteTestScenes,
  describeIfSceneDb,
  openSceneTestDb,
  SCENE_DB_URL,
} from '../testing/scene-test-db';
import { SceneLockService } from './scene-lock.service';
import { SceneTurnService } from './scene-turn.service';

describeIfSceneDb('SceneTurnService (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let service: SceneTurnService;
  let publish: jest.Mock;
  let publishedInTransaction: boolean[];
  const createdScenes: string[] = [];

  beforeAll(async () => {
    dataSource = await openSceneTestDb();
  });

  beforeEach(() => {
    publishedInTransaction = [];
    publish = jest.fn(async (_queue, _data, options) => {
      publishedInTransaction.push(Boolean(options?.manager?.queryRunner?.isTransactionActive));
      return `job-${publish.mock.calls.length}`;
    });
    service = new SceneTurnService(dataSource, new SceneLockService(dataSource), {
      publish,
    } as unknown as AnimationQueueService);
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
  });

  const newScene = async (name: string) => {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    return scene;
  };
  /** Cena com a versão 1 pronta (revisão 0) e, opcionalmente, camadas. */
  const readyScene = async (name: string, elements: TemplateSceneVersion['elements'] = []) => {
    const scene = await newScene(name);
    const { version } = await insertReadyVersion(dataSource, scene, 1, { elements });
    scene.currentVersionId = version.id;
    await dataSource.manager.save(scene);
    return scene;
  };
  const message = (content = 'campo verde com sol', expectedRevision = 0) => ({
    content,
    expectedRevision,
  });
  const versionsOf = (sceneId: string) =>
    dataSource.manager.find(TemplateSceneVersion, { where: { sceneId }, order: { number: 'ASC' } });
  const revisionOf = async (sceneId: string) =>
    (await dataSource.manager.findOneByOrFail(TemplateScene, { id: sceneId })).revision;

  describe('sendMessage', () => {
    it('Mensagem aparece na hora: grava a mensagem e a versão queued no step reading e publica o job do Diretor (retryLimit 0) na mesma transação', async () => {
      const scene = await newScene('Turno primeira');

      const result = await service.sendMessage(scene.id, message(), null);

      expect(result).toEqual({
        messageId: expect.any(String),
        versionId: expect.any(String),
        jobId: 'job-1',
        revision: 1,
      });
      expect(result).not.toHaveProperty('assistantMessage');
      expect(result).not.toHaveProperty('operation');
      const [version] = await versionsOf(scene.id);
      expect(version).toMatchObject({
        id: result.versionId,
        number: 1,
        operation: 'generate',
        status: 'queued',
        step: 'reading',
        parentVersionId: null,
        requestedRegion: null,
        requestedMask: null,
        targetElementId: null,
      });
      const stored = await dataSource.manager.findOneByOrFail(TemplateSceneMessage, {
        id: result.messageId,
      });
      expect(stored).toMatchObject({
        role: 'user',
        status: 'queued',
        versionId: version.id,
        content: 'campo verde com sol',
      });
      expect(publish).toHaveBeenCalledTimes(1);
      const [queue, data, options] = publish.mock.calls[0];
      expect(queue).toBe(QUEUES.TEMPLATE_SCENE_DIRECTOR);
      expect(data).toEqual({ sceneId: scene.id, versionId: version.id });
      expect(options).toMatchObject({ retryLimit: 0, expireInSeconds: 180 });
      expect(options.startAfterSeconds).toBeUndefined();
      expect(publishedInTransaction).toEqual([true]);
    });

    it('emite version.step com reading e status queued, depois de bumpRevision, na mesma transação', async () => {
      const scene = await newScene('Turno evento');
      const client = new Client({ connectionString: SCENE_DB_URL });
      await client.connect();
      const events: Array<Record<string, unknown>> = [];
      client.on('notification', (n) => events.push(JSON.parse(n.payload ?? '{}')));
      await client.query(`LISTEN ${TEMPLATE_SCENE_EVENTS_CHANNEL}`);
      try {
        const result = await service.sendMessage(scene.id, message(), null);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const mine = events.filter((event) => event.sceneId === scene.id);
        expect(mine).toEqual([
          expect.objectContaining({
            kind: 'version.step',
            step: 'reading',
            status: 'queued',
            versionId: result.versionId,
            revision: 1,
          }),
        ]);
      } finally {
        await client.end();
      }
    });

    it('em cena com imagem a operação inicial é redraw, filha da versão atual', async () => {
      const scene = await readyScene('Turno redraw');
      const result = await service.sendMessage(scene.id, message('tira o coelho', 0), null);
      const versions = await versionsOf(scene.id);
      expect(versions[1]).toMatchObject({
        id: result.versionId,
        operation: 'redraw',
        status: 'queued',
        step: 'reading',
        parentVersionId: versions[0].id,
      });
    });

    it('Segunda mensagem durante a leitura: 409 SCENE_BUSY, nenhum job novo e nenhuma chamada ao Diretor', async () => {
      const scene = await newScene('Turno ocupada');
      await service.sendMessage(scene.id, message(), null);

      expect(await errorOf(service.sendMessage(scene.id, message('outra', 1), null))).toEqual({
        status: 409,
        code: 'SCENE_BUSY',
      });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await versionsOf(scene.id)).toHaveLength(1);
    });

    it('reenvio com revisão antiga: 409 REVISION_CONFLICT', async () => {
      const scene = await newScene('Turno revisão');
      await dataSource.manager.update(TemplateScene, { id: scene.id }, { revision: 3 });
      expect(await errorOf(service.sendMessage(scene.id, message('x', 2), null))).toEqual({
        status: 409,
        code: 'REVISION_CONFLICT',
      });
      expect(publish).not.toHaveBeenCalled();
    });

    it('Duas abas com a mesma revisão: uma 202, a outra 409, uma só versão queued e um só job do Diretor', async () => {
      const scene = await newScene('Turno corrida');
      await dataSource.manager.update(TemplateScene, { id: scene.id }, { revision: 2 });

      const results = await Promise.allSettled([
        service.sendMessage(scene.id, message('a', 2), null),
        service.sendMessage(scene.id, message('b', 2), null),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(['REVISION_CONFLICT', 'SCENE_BUSY']).toContain(rejected.reason.getResponse().code);
      expect((await versionsOf(scene.id)).filter((v) => v.status === 'queued')).toHaveLength(1);
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('o índice parcial UQ_tsv_scene_busy impede duas versões em curso direto no banco', async () => {
      const scene = await newScene('Turno índice');
      await insertVersion(dataSource, scene.id, { number: 1, status: 'queued' });
      await expect(
        insertVersion(dataSource, scene.id, { number: 2, status: 'running' }),
      ).rejects.toMatchObject({
        driverError: { code: '23505', constraint: 'UQ_tsv_scene_busy' },
      });
      await insertVersion(dataSource, scene.id, { number: 3, status: 'failed' });
    });

    it('depois de uma geração que falhou, tentar de novo é permitido (versão 2)', async () => {
      const scene = await newScene('Turno retry');
      await insertVersion(dataSource, scene.id, {
        number: 1,
        status: 'failed',
        errorCode: 'PROVIDER_ERROR',
      });

      const result = await service.sendMessage(scene.id, message('campo', 0), null);

      const versions = await versionsOf(scene.id);
      expect(versions.map((v) => v.number)).toEqual([1, 2]);
      expect(versions[1].id).toBe(result.versionId);
    });

    it('anexo de outra cena: 422 ASSET_NOT_IN_SCENE e nada é criado', async () => {
      const a = await newScene('Turno anexo A');
      const b = await newScene('Turno anexo B');
      const { version } = await insertReadyVersion(dataSource, b, 1);
      const foreign = await insertAsset(dataSource, version, 'logo');

      const body = { ...message(), attachments: [{ assetId: foreign.id }] };
      expect(await errorOf(service.sendMessage(a.id, body, null))).toEqual({
        status: 422,
        code: 'ASSET_NOT_IN_SCENE',
      });
      expect(await versionsOf(a.id)).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
    });

    it('anexo da própria cena que não é logo (master, crop, mask): 422 e nada é criado (R3)', async () => {
      const scene = await newScene('Turno anexo papel');
      const { version } = await insertReadyVersion(dataSource, scene, 1);
      for (const role of ['master', 'crop', 'mask'] as const) {
        const other = await insertAsset(dataSource, version, role);
        const body = { ...message(), attachments: [{ assetId: other.id }] };
        expect(await errorOf(service.sendMessage(scene.id, body, null))).toEqual({
          status: 422,
          code: 'ASSET_NOT_IN_SCENE',
        });
      }
      const logo = await insertAsset(dataSource, version, 'logo');
      await expect(
        service.sendMessage(scene.id, { ...message(), attachments: [{ assetId: logo.id }] }, null),
      ).resolves.toBeDefined();
      expect(publish).toHaveBeenCalledTimes(1);
    });

    it('falha ao publicar o job desfaz tudo (sem versão órfã e sem revisão nova)', async () => {
      const scene = await newScene('Turno rollback');
      publish.mockRejectedValueOnce(new Error('fila fora do ar'));

      await expect(service.sendMessage(scene.id, message(), null)).rejects.toThrow(
        'fila fora do ar',
      );

      expect(await versionsOf(scene.id)).toHaveLength(0);
      expect(await dataSource.manager.countBy(TemplateSceneMessage, { sceneId: scene.id })).toBe(0);
      expect(await revisionOf(scene.id)).toBe(0);
    });

    it('cena inexistente: 404', async () => {
      expect(
        await errorOf(service.sendMessage('00000000-0000-4000-8000-000000000000', message(), null)),
      ).toEqual({ status: 404, code: 'SCENE_NOT_FOUND' });
    });
  });

  describe('alvo da mensagem', () => {
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };

    it('retângulo, zona e forma ficam gravados na versão; o elemento é só dica de camada', async () => {
      const scene = await readyScene('Alvo grava', [
        {
          id: 'logo-1',
          kind: 'logo',
          name: 'Logo 1',
          x: 0.5,
          y: 0.1,
          w: 0.3,
          aspect: 2,
          rotation: 0,
          z: 1,
        },
      ]);
      let revision = 0;
      const send = async (extra: Record<string, unknown>) => {
        const result = await service.sendMessage(
          scene.id,
          { ...message('tira isso', revision), ...extra } as never,
          null,
        );
        revision = result.revision;
        const version = (await versionsOf(scene.id)).find((v) => v.id === result.versionId);
        // libera a cena para a próxima mensagem
        await dataSource.manager.update(
          TemplateSceneVersion,
          { id: result.versionId },
          { status: 'rejected' },
        );
        return version as TemplateSceneVersion;
      };

      const byRegion = await send({ region: rect });
      expect(byRegion).toMatchObject({
        requestedRegion: rect,
        requestedMask: null,
        targetElementId: null,
      });

      const byZone = await send({ zone: 'footer' });
      expect(byZone.requestedMask).toBeNull();
      expect(byZone.requestedRegion).toMatchObject({ x: 0, w: 1 });
      expect(byZone.requestedRegion?.y).toBeGreaterThan(0.5);

      const lasso = {
        kind: 'lasso',
        points: [
          { x: 0.2, y: 0.2 },
          { x: 0.6, y: 0.2 },
          { x: 0.4, y: 0.5 },
        ],
      };
      const byMask = await send({ mask: lasso });
      expect(byMask.requestedMask).toEqual(lasso);
      expect(byMask.requestedRegion).toMatchObject({ x: 0.2, y: 0.2 });

      const byElement = await send({ targetElementId: 'logo-1' });
      expect(byElement).toMatchObject({
        targetElementId: 'logo-1',
        requestedRegion: null,
        requestedMask: null,
      });
    });

    it('Marcação pequena demais: 422 REGION_TOO_SMALL, sem Diretor, sem versão e sem mensagem', async () => {
      const scene = await readyScene('Alvo pequeno');
      const body = { ...message('tira isso'), region: { x: 0.1, y: 0.1, w: 0.02, h: 0.02 } };
      expect(await errorOf(service.sendMessage(scene.id, body as never, null))).toEqual({
        status: 422,
        code: 'REGION_TOO_SMALL',
      });
      expect(publish).not.toHaveBeenCalled();
      expect(await versionsOf(scene.id)).toHaveLength(1);
      expect(await dataSource.manager.countBy(TemplateSceneMessage, { sceneId: scene.id })).toBe(0);
    });

    it('Dois alvos: 400 e nada é gravado', async () => {
      const scene = await readyScene('Alvo dois');
      const body = {
        ...message('tira isso'),
        region: rect,
        mask: {
          kind: 'lasso',
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0.5, y: 1 },
          ],
        },
      };
      expect(await errorOf(service.sendMessage(scene.id, body as never, null))).toEqual({
        status: 400,
        code: 'BAD_REQUEST',
      });
      expect(publish).not.toHaveBeenCalled();
      expect(await versionsOf(scene.id)).toHaveLength(1);
    });

    it('elemento que não existe na versão atual: 422 TARGET_ELEMENT_NOT_FOUND', async () => {
      const scene = await readyScene('Alvo elemento');
      const body = { ...message('tira isso'), targetElementId: 'fantasma' };
      expect(await errorOf(service.sendMessage(scene.id, body as never, null))).toEqual({
        status: 422,
        code: 'TARGET_ELEMENT_NOT_FOUND',
      });
      expect(publish).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('versão running: registra o pedido na hora e continua running; cena segue ocupada', async () => {
      const scene = await newScene('Cancela running');
      const running = await insertVersion(dataSource, scene.id, {
        number: 1,
        status: 'running',
        step: 'generating',
      });

      const result = await service.cancel(scene.id, running.id);

      expect(result).toMatchObject({ versionId: running.id, status: 'running', revision: 1 });
      expect(new Date(result.cancelRequestedAt).getTime()).toBeGreaterThan(0);
      expect(await errorOf(service.sendMessage(scene.id, message('outra', 1), null))).toEqual({
        status: 409,
        code: 'SCENE_BUSY',
      });
    });

    it('repetir o cancelamento em curso responde igual, sem mudar a revisão', async () => {
      const scene = await newScene('Cancela repete');
      const running = await insertVersion(dataSource, scene.id, { number: 1, status: 'running' });

      const first = await service.cancel(scene.id, running.id);
      const second = await service.cancel(scene.id, running.id);

      expect(second).toEqual(first);
      expect(await revisionOf(scene.id)).toBe(1);
    });

    it('versão queued é cancelada na hora, com resposta no chat, e libera a cena', async () => {
      const scene = await newScene('Cancela queued');
      const sent = await service.sendMessage(scene.id, message(), null);

      const result = await service.cancel(scene.id, sent.versionId);

      expect(result.status).toBe('cancelled');
      const messages = await dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId: scene.id },
        order: { createdAt: 'ASC' },
      });
      expect(messages.map((m) => [m.role, m.status])).toEqual([
        ['user', 'failed'],
        ['assistant', 'done'],
      ]);
      expect(messages[1].content).toBe('Geração cancelada.');
      const again = await service.sendMessage(
        scene.id,
        message('nova tentativa', result.revision),
        null,
      );
      expect(again.versionId).not.toBe(sent.versionId);
    });

    it.each(['ready', 'failed', 'cancelled'] as const)(
      'versão %s: 409 VERSION_NOT_CANCELLABLE',
      async (status) => {
        const scene = await newScene(`Cancela final ${status}`);
        const version = await insertVersion(dataSource, scene.id, { number: 1, status });
        expect(await errorOf(service.cancel(scene.id, version.id))).toEqual({
          status: 409,
          code: 'VERSION_NOT_CANCELLABLE',
        });
      },
    );

    it('versão inexistente ou de outra cena: 404 VERSION_NOT_FOUND', async () => {
      const a = await newScene('Cancela 404 A');
      const b = await newScene('Cancela 404 B');
      const other = await insertVersion(dataSource, b.id, { number: 1, status: 'running' });
      expect(await errorOf(service.cancel(a.id, other.id))).toEqual({
        status: 404,
        code: 'VERSION_NOT_FOUND',
      });
    });
  });
});
