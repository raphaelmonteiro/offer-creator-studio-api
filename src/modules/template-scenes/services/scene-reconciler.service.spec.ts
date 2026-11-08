import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TemplateSceneMessage } from '../entities/template-scene-message.entity';
import { TemplateScene } from '../entities/template-scene.entity';
import { TemplateSceneVersion } from '../entities/template-scene-version.entity';
import { SceneTurnState } from '../processors/scene-turn-state';
import {
  insertMessage,
  insertReadyVersion,
  insertScene,
  insertVersion,
} from '../testing/scene-fixtures';
import { fakeQueue } from '../testing/scene-test-helpers';
import { deleteTestScenes, describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { SceneLockService } from './scene-lock.service';
import {
  READING_STALE_AFTER_MS,
  RECONCILE_INTERVAL_MS,
  SceneReconcilerService,
  STALE_AFTER_MS,
} from './scene-reconciler.service';

describeIfSceneDb('SceneReconcilerService (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let reconciler: SceneReconcilerService;
  const createdScenes: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await openSceneTestDb();
    const locks = new SceneLockService(dataSource);
    reconciler = new SceneReconcilerService(
      dataSource,
      locks,
      new SceneTurnState(locks, fakeQueue().service),
    );
  });

  afterAll(async () => {
    await deleteTestScenes(dataSource, createdScenes);
    await dataSource.destroy();
  });

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const setUpdatedAt = (versionId: string, at: Date) =>
    dataSource.query(`UPDATE template_scene_versions SET "updatedAt" = $2 WHERE id = $1`, [
      versionId,
      at,
    ]);

  async function sceneWith(
    name: string,
    overrides: Partial<TemplateSceneVersion>,
    ageMinutes: number,
  ) {
    const scene = await insertScene(dataSource, { name });
    createdScenes.push(scene.id);
    const version = await insertVersion(dataSource, scene.id, { number: 1, ...overrides });
    await insertMessage(dataSource, scene.id, { versionId: version.id, status: 'queued' });
    await setUpdatedAt(version.id, minutesAgo(ageMinutes));
    return { scene, version };
  }

  const versionOf = (id: string) =>
    dataSource.manager.findOneByOrFail(TemplateSceneVersion, { id });

  it('worker reiniciado: versão running parada há mais de 16 min vira JOB_EXPIRED, com mensagem no chat', async () => {
    const { scene, version } = await sceneWith(
      'Recon running',
      { status: 'running', step: 'generating' },
      20,
    );

    const expired = await reconciler.reconcile();

    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await versionOf(version.id)).toMatchObject({
      status: 'failed',
      errorCode: 'JOB_EXPIRED',
    });
    const messages = await dataSource.manager.find(TemplateSceneMessage, {
      where: { sceneId: scene.id },
      order: { createdAt: 'ASC' },
    });
    expect(messages[0].status).toBe('failed');
    expect(messages[1].content).toContain('interrompido');
    expect(
      (await dataSource.manager.findOneByOrFail(TemplateScene, { id: scene.id })).revision,
    ).toBe(1);
  });

  it('a cena volta a ficar livre: o índice de cena ocupada aceita uma versão nova', async () => {
    const { scene } = await sceneWith('Recon libera', { status: 'queued' }, 30);
    await reconciler.reconcile();
    const next = await insertVersion(dataSource, scene.id, { number: 2, status: 'queued' });
    expect(next.status).toBe('queued');
  });

  it('versão queued antiga também expira', async () => {
    const { version } = await sceneWith('Recon queued', { status: 'queued' }, 17);
    await reconciler.reconcile();
    expect((await versionOf(version.id)).errorCode).toBe('JOB_EXPIRED');
  });

  it('versão recente (dentro dos 16 min) não é tocada', async () => {
    const { version } = await sceneWith('Recon recente', { status: 'running' }, 5);
    await reconciler.reconcile();
    expect((await versionOf(version.id)).status).toBe('running');
  });

  it('versão em estado final não é tocada, por mais antiga que seja', async () => {
    const scene = await insertScene(dataSource, { name: 'Recon final' });
    createdScenes.push(scene.id);
    const { version } = await insertReadyVersion(dataSource, scene, 1);
    await setUpdatedAt(version.id, minutesAgo(600));
    await reconciler.reconcile();
    expect((await versionOf(version.id)).status).toBe('ready');
  });

  it('chamada paga pendente fica marcada como falha, com o custo desconhecido', async () => {
    const pending = {
      id: 'c1',
      kind: 'generate' as const,
      status: 'pending' as const,
      model: 'm',
      size: '1x1',
      startedAt: new Date().toISOString(),
    };
    const { version } = await sceneWith(
      'Recon pendente',
      { status: 'running', metrics: { calls: [pending] } },
      20,
    );

    await reconciler.reconcile();

    const done = await versionOf(version.id);
    expect(done.metrics.costUnknown).toBe(true);
    expect(done.metrics.calls).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'JOB_EXPIRED' }),
    ]);
  });

  it('cena excluída: a versão presa também é resolvida', async () => {
    const { scene, version } = await sceneWith('Recon excluída', { status: 'running' }, 20);
    await dataSource.manager.softDelete(TemplateScene, { id: scene.id });
    await reconciler.reconcile();
    expect((await versionOf(version.id)).errorCode).toBe('JOB_EXPIRED');
  });

  it('o limite é de 16 minutos, e o da leitura é de 2, com a varredura a cada minuto', () => {
    expect(STALE_AFTER_MS).toBe(16 * 60 * 1000);
    expect(READING_STALE_AFTER_MS).toBe(2 * 60 * 1000);
    expect(RECONCILE_INTERVAL_MS).toBe(60 * 1000);
  });

  describe('a leitura do Diretor tem limite próprio', () => {
    it('Worker reiniciado durante a leitura: a versão em reading há 3 min fica failed, o chat diz que foi interrompido e o envio volta', async () => {
      const { scene, version } = await sceneWith(
        'Recon leitura',
        { status: 'queued', step: 'reading' },
        3,
      );

      await reconciler.reconcile();

      expect(await versionOf(version.id)).toMatchObject({
        status: 'failed',
        errorCode: 'JOB_EXPIRED',
      });
      const messages = await dataSource.manager.find(TemplateSceneMessage, {
        where: { sceneId: scene.id },
        order: { createdAt: 'ASC' },
      });
      expect(messages[0].status).toBe('failed');
      expect(messages[1].content).toContain('interrompido');
      const next = await insertVersion(dataSource, scene.id, { number: 2, status: 'queued' });
      expect(next.status).toBe('queued');
    });

    it('R12: leitura presa marca costUnknown, porque o Diretor pode ter sido cobrado sem tentativa gravada', async () => {
      const { version } = await sceneWith(
        'Recon leitura custo',
        { status: 'queued', step: 'reading' },
        3,
      );
      await reconciler.reconcile();
      expect((await versionOf(version.id)).metrics.costUnknown).toBe(true);
    });

    it('R12: a marca costUnknown que já estava gravada não é apagada ao expirar', async () => {
      const { version } = await sceneWith(
        'Recon marca',
        { status: 'running', step: 'editing', metrics: { costUnknown: true } },
        20,
      );
      await reconciler.reconcile();
      expect((await versionOf(version.id)).metrics.costUnknown).toBe(true);
    });

    it('R12: sem chamada pendente e sem marca, nada é marcado', async () => {
      const { version } = await sceneWith(
        'Recon limpa',
        { status: 'running', step: 'editing' },
        20,
      );
      await reconciler.reconcile();
      expect((await versionOf(version.id)).metrics.costUnknown).toBeUndefined();
    });

    it('Imagem esperando vaga não expira como leitura: queued com step nulo há 3 min continua queued', async () => {
      const { version } = await sceneWith('Recon vaga', { status: 'queued', step: null }, 3);
      await reconciler.reconcile();
      expect((await versionOf(version.id)).status).toBe('queued');
    });

    it('a leitura recente (1 min) não é tocada', async () => {
      const { version } = await sceneWith(
        'Recon leitura recente',
        { status: 'queued', step: 'reading' },
        1,
      );
      await reconciler.reconcile();
      expect(await versionOf(version.id)).toMatchObject({ status: 'queued', step: 'reading' });
    });

    it('imagem rodando há 10 min também segue nos 16', async () => {
      const { version } = await sceneWith(
        'Recon rodando',
        { status: 'running', step: 'generating' },
        10,
      );
      await reconciler.reconcile();
      expect((await versionOf(version.id)).status).toBe('running');
    });

    it('trocar o step ao publicar o job de imagem atualiza updatedAt: a versão que acabou de sair da leitura não cai no limite curto', async () => {
      const { version } = await sceneWith(
        'Recon saiu da leitura',
        { status: 'queued', step: 'reading' },
        3,
      );
      await dataSource.manager.update(TemplateSceneVersion, { id: version.id }, { step: null });
      expect((await versionOf(version.id)).updatedAt.getTime()).toBeGreaterThan(
        minutesAgo(1).getTime(),
      );
      await reconciler.reconcile();
      expect((await versionOf(version.id)).status).toBe('queued');
    });
  });
});
