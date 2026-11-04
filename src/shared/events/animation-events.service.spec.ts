import { DataSource } from 'typeorm';
import {
  AnimationEventsService,
  MC_EVENTS_CHANNEL,
  TEMPLATE_SCENE_EVENTS_CHANNEL,
} from './animation-events.service';

const mockQuery = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockEnd = jest.fn().mockResolvedValue(undefined);
const mockOn = jest.fn();
jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
    on: mockOn,
  })),
}));

const dataSource = {
  options: { host: 'h', port: 1, username: 'u', password: 'p', database: 'd' },
} as unknown as DataSource;

describe('AnimationEventsService: canal da cena de template', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.clearAllMocks();
  });

  describe('roteamento por cena', () => {
    it('o evento da cena A chega a quem assina A e não a quem assina B', () => {
      const service = new AnimationEventsService(dataSource);
      const a = jest.fn();
      const b = jest.fn();
      service.subscribeScene('scene-a', a);
      service.subscribeScene('scene-b', b);

      const event = { sceneId: 'scene-a', kind: 'version.ready', revision: 3 };
      service.handleNotification({
        channel: TEMPLATE_SCENE_EVENTS_CHANNEL,
        payload: JSON.stringify(event),
      });

      expect(a).toHaveBeenCalledWith(event);
      expect(b).not.toHaveBeenCalled();
    });

    it('vários assinantes da mesma cena (outras abas, outros usuários) recebem o evento', () => {
      const service = new AnimationEventsService(dataSource);
      const first = jest.fn();
      const second = jest.fn();
      service.subscribeScene('s', first);
      service.subscribeScene('s', second);
      service.handleNotification({
        channel: TEMPLATE_SCENE_EVENTS_CHANNEL,
        payload: JSON.stringify({ sceneId: 's' }),
      });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('cancelar a assinatura para de entregar', () => {
      const service = new AnimationEventsService(dataSource);
      const listener = jest.fn();
      const unsubscribe = service.subscribeScene('s', listener);
      unsubscribe();
      service.handleNotification({
        channel: TEMPLATE_SCENE_EVENTS_CHANNEL,
        payload: JSON.stringify({ sceneId: 's' }),
      });
      expect(listener).not.toHaveBeenCalled();
    });

    it('o canal da cena não vaza para as assinaturas por usuário, e vice-versa', () => {
      const service = new AnimationEventsService(dataSource);
      const sceneListener = jest.fn();
      const userListener = jest.fn();
      service.subscribeScene('u1', sceneListener);
      service.subscribe('u1', userListener, MC_EVENTS_CHANNEL);

      service.handleNotification({
        channel: MC_EVENTS_CHANNEL,
        payload: JSON.stringify({ userId: 'u1', sceneId: 'u1' }),
      });
      expect(userListener).toHaveBeenCalledTimes(1);
      expect(sceneListener).not.toHaveBeenCalled();

      service.handleNotification({
        channel: TEMPLATE_SCENE_EVENTS_CHANNEL,
        payload: JSON.stringify({ sceneId: 'u1', userId: 'u1' }),
      });
      expect(sceneListener).toHaveBeenCalledTimes(1);
      expect(userListener).toHaveBeenCalledTimes(1);
    });

    it('payload inválido ou ausente é ignorado sem lançar', () => {
      const service = new AnimationEventsService(dataSource);
      expect(() =>
        service.handleNotification({
          channel: TEMPLATE_SCENE_EVENTS_CHANNEL,
          payload: '{nao json',
        }),
      ).not.toThrow();
      expect(() =>
        service.handleNotification({ channel: TEMPLATE_SCENE_EVENTS_CHANNEL }),
      ).not.toThrow();
    });
  });

  describe('subida do LISTEN', () => {
    it('sobe com animações e comerciais desligados e a flag da cena ligada, escutando o canal novo', async () => {
      process.env.ANIMATIONS_ENABLED = 'false';
      process.env.MC_ENABLED = 'false';
      process.env.TEMPLATE_SCENE_ENABLED = 'true';
      delete process.env.WORKER_ONLY;
      const service = new AnimationEventsService(dataSource);
      await service.onModuleInit();
      expect(mockConnect).toHaveBeenCalledTimes(1);
      const listened = mockQuery.mock.calls.map((call) => call[0]);
      expect(listened).toContain(`LISTEN ${TEMPLATE_SCENE_EVENTS_CHANNEL}`);
    });

    it('não sobe com tudo desligado', async () => {
      process.env.ANIMATIONS_ENABLED = 'false';
      process.env.MC_ENABLED = 'false';
      process.env.TEMPLATE_SCENE_ENABLED = 'false';
      delete process.env.WORKER_ONLY;
      await new AnimationEventsService(dataSource).onModuleInit();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('não sobe no worker', async () => {
      process.env.WORKER_ONLY = 'true';
      process.env.TEMPLATE_SCENE_ENABLED = 'true';
      await new AnimationEventsService(dataSource).onModuleInit();
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });
});
