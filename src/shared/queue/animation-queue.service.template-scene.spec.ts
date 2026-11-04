import { ConfigService } from '@nestjs/config';
import { AnimationQueueService, QUEUES } from './animation-queue.service';

const mockBoss = {
  on: jest.fn(),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  send: jest.fn().mockResolvedValue('job-1'),
};
// `import PgBoss = require('pg-boss')` usa o próprio módulo como construtor.
jest.mock('pg-boss', () => jest.fn().mockImplementation(() => mockBoss));

function serviceWith(env: Record<string, string>): AnimationQueueService {
  const config = new ConfigService(env);
  return new AnimationQueueService(config);
}

describe('AnimationQueueService: cena de template', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('retryLimit', () => {
    let service: AnimationQueueService;
    beforeEach(() => {
      service = serviceWith({});
      (service as unknown as { boss: unknown }).boss = mockBoss;
    });

    it('mantém o padrão 3 para os outros chamadores', async () => {
      await service.publish(QUEUES.MC_TTS, { stepId: 's' });
      expect(mockBoss.send.mock.calls[0][2]).toMatchObject({ retryLimit: 3 });
    });

    it('respeita 0 (a cena não repete chamada paga)', async () => {
      await service.publish(QUEUES.TEMPLATE_SCENE_TURN, { versionId: 'v' }, { retryLimit: 0 });
      expect(mockBoss.send.mock.calls[0][0]).toBe('template_scene.turn');
      expect(mockBoss.send.mock.calls[0][2]).toMatchObject({ retryLimit: 0 });
    });
  });

  describe('subida da fila', () => {
    it('sobe com animações ligadas (padrão)', async () => {
      await serviceWith({}).onModuleInit();
      expect(mockBoss.start).toHaveBeenCalledTimes(1);
    });

    it('sobe com animações desligadas e a flag da cena ligada', async () => {
      await serviceWith({
        ANIMATIONS_ENABLED: 'false',
        TEMPLATE_SCENE_ENABLED: 'true',
      }).onModuleInit();
      expect(mockBoss.start).toHaveBeenCalledTimes(1);
    });

    it('não sobe com as duas desligadas', async () => {
      await serviceWith({ ANIMATIONS_ENABLED: 'false' }).onModuleInit();
      await serviceWith({
        ANIMATIONS_ENABLED: 'false',
        TEMPLATE_SCENE_ENABLED: 'false',
      }).onModuleInit();
      expect(mockBoss.start).not.toHaveBeenCalled();
    });
  });
});
