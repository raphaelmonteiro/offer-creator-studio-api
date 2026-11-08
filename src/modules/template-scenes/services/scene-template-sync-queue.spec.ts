import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { describeIfSceneDb, openSceneTestDb } from '../testing/scene-test-db';
import { enqueueTemplateSync } from './scene-events';

/** pg-boss real no banco `chroma_x_e2e`: o job nasce e morre com a transação do chamador. */
describeIfSceneDb('enqueueTemplateSync com o pg-boss real (banco chroma_x_e2e)', () => {
  let dataSource: DataSource;
  let queue: AnimationQueueService;
  const sceneIds: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await openSceneTestDb();
    const opts = dataSource.options as unknown as Record<string, string | number>;
    queue = new AnimationQueueService(
      new ConfigService({
        TEMPLATE_SCENE_ENABLED: 'true',
        ANIMATIONS_ENABLED: 'false',
        DB_HOST: opts.host,
        DB_PORT: opts.port,
        DB_USERNAME: opts.username,
        DB_PASSWORD: opts.password,
        DB_DATABASE: opts.database,
      }),
    );
    await queue.onModuleInit();
  });

  afterAll(async () => {
    await dataSource.query(
      `DELETE FROM pgboss.job WHERE name = $1 AND data->>'sceneId' = ANY($2)`,
      [QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC, sceneIds],
    );
    await queue.onModuleDestroy();
    await dataSource.destroy();
  });

  const jobsOf = (sceneId: string) =>
    dataSource.query(
      `SELECT state, singletonkey AS "singletonKey", retrylimit AS "retryLimit", startafter > now() AS waiting,
              startafter < now() + interval '6 seconds' AS soon
       FROM pgboss.job WHERE name = $1 AND data->>'sceneId' = $2`,
      [QUEUES.TEMPLATE_SCENE_TEMPLATE_SYNC, sceneId],
    );
  const newId = () => {
    const id = randomUUID();
    sceneIds.push(id);
    return id;
  };

  it('commit: o job aparece, com a chave da cena, 2 retentativas e a espera de 5 s', async () => {
    const sceneId = newId();
    await dataSource.transaction((manager) => enqueueTemplateSync(queue, manager, sceneId));

    expect(await jobsOf(sceneId)).toEqual([
      { state: 'created', singletonKey: sceneId, retryLimit: 2, waiting: true, soon: true },
    ]);
  });

  it('transação desfeita: nenhum job', async () => {
    const sceneId = newId();
    await expect(
      dataSource.transaction(async (manager) => {
        await enqueueTemplateSync(queue, manager, sceneId);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await jobsOf(sceneId)).toEqual([]);
  });

  it('rajada: várias mudanças enquanto o job espera continuam um job só', async () => {
    const sceneId = newId();
    for (let i = 0; i < 3; i += 1) {
      await dataSource.transaction((manager) => enqueueTemplateSync(queue, manager, sceneId));
    }

    expect(await jobsOf(sceneId)).toHaveLength(1);
  });

  it('cenas diferentes têm jobs diferentes', async () => {
    const [a, b] = [newId(), newId()];
    await dataSource.transaction(async (manager) => {
      await enqueueTemplateSync(queue, manager, a);
      await enqueueTemplateSync(queue, manager, b);
    });

    expect(await jobsOf(a)).toHaveLength(1);
    expect(await jobsOf(b)).toHaveLength(1);
  });
});
