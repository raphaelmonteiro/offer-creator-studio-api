import { ConfigService } from '@nestjs/config';
import { AnimationQueueService, QUEUES } from './animation-queue.service';

const mockBoss = {
  on: jest.fn(),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue('job-1'),
  work: jest.fn().mockResolvedValue('worker-1'),
};
// `import PgBoss = require('pg-boss')` usa o próprio módulo como construtor.
jest.mock('pg-boss', () => jest.fn().mockImplementation(() => mockBoss));

function serviceWith(env: Record<string, string>): AnimationQueueService {
  return new AnimationQueueService(new ConfigService(env));
}

const ONLY_THE_JOB = { ANIMATIONS_ENABLED: 'false' };

describe('AnimationQueueService: job do Encarte Pro (change 28)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('a fila do job tem o nome flyer_pro.enrich', () => {
    expect(QUEUES.FLYER_PRO_ENRICH).toBe('flyer_pro.enrich');
  });

  describe('subida da fila', () => {
    it('fila só pelo job: animações desligadas, cena e flag do job ausentes', async () => {
      await serviceWith(ONLY_THE_JOB).onModuleInit();
      expect(mockBoss.start).toHaveBeenCalledTimes(1);
    });

    it('o job liga a fila com qualquer valor diferente de false', async () => {
      await serviceWith({ ...ONLY_THE_JOB, FLYER_PRO_ENRICH_ENABLED: '0' }).onModuleInit();
      await serviceWith({ ...ONLY_THE_JOB, FLYER_PRO_ENRICH_ENABLED: 'true' }).onModuleInit();
      expect(mockBoss.start).toHaveBeenCalledTimes(2);
    });

    it('tudo desligado: a fila não sobe', async () => {
      await serviceWith({ ...ONLY_THE_JOB, FLYER_PRO_ENRICH_ENABLED: 'false' }).onModuleInit();
      expect(mockBoss.start).not.toHaveBeenCalled();
    });

    it('com a flag do job desligada, animações e cena ligadas seguem subindo a fila', async () => {
      await serviceWith({ FLYER_PRO_ENRICH_ENABLED: 'false' }).onModuleInit();
      await serviceWith({
        ANIMATIONS_ENABLED: 'false',
        TEMPLATE_SCENE_ENABLED: 'true',
        FLYER_PRO_ENRICH_ENABLED: 'false',
      }).onModuleInit();
      expect(mockBoss.start).toHaveBeenCalledTimes(2);
    });
  });

  describe('publicação e consumo', () => {
    let service: AnimationQueueService;
    beforeEach(() => {
      service = serviceWith({});
      (service as unknown as { boss: unknown }).boss = mockBoss;
    });

    it('lote do job: as opções vão como pedidas (retryLimit 0, expiração de 300 s) e o publish não muda', async () => {
      await service.publish(
        QUEUES.FLYER_PRO_ENRICH,
        { jobId: 'j1', seq: 0 },
        { retryLimit: 0, expireInSeconds: 300 },
      );

      expect(mockBoss.send).toHaveBeenCalledWith(
        'flyer_pro.enrich',
        { jobId: 'j1', seq: 0 },
        expect.objectContaining({ retryLimit: 0, retryBackoff: true, expireInSeconds: 300 }),
      );
    });

    it('a publicação das cenas continua com as opções de antes', async () => {
      await service.publish(QUEUES.TEMPLATE_SCENE_TURN, { versionId: 'v' }, { retryLimit: 0 });

      expect(mockBoss.send.mock.calls[0][2]).toEqual({
        startAfter: undefined,
        singletonKey: undefined,
        retryLimit: 0,
        retryBackoff: true,
        expireInSeconds: 900,
      });
    });

    it('o consumidor do job registra a concorrência pedida com a busca a cada 2 s', async () => {
      await service.subscribe(QUEUES.FLYER_PRO_ENRICH, 2, jest.fn());

      expect(mockBoss.work).toHaveBeenCalledWith(
        'flyer_pro.enrich',
        { teamSize: 2, teamConcurrency: 2, newJobCheckIntervalSeconds: 2 },
        expect.any(Function),
      );
    });
  });
});
