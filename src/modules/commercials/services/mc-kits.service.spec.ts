import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { MC_IMAGE_EXPIRE_S, McKitsService } from './mc-kits.service';
import { McVoicesService } from './mc-voices.service';

describe('McKitsService — fluxo real do kit (plano §4/§6.8)', () => {
  let tmpDir: string;
  const mascotBase = {
    id: 'mascot-1',
    rightsConfirmedAt: new Date(),
    cutoutUrl: '/uploads/mascots/cutout.png',
    sourceImageUrl: '/uploads/mascots/source.png',
  };

  let manager: { getRepository: jest.Mock; save: jest.Mock; update: jest.Mock };
  let kitRepo: {
    save: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    find: jest.Mock;
  };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let mascots: { findOne: jest.Mock };
  let moderation: { moderate: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let voices: { resolveProviderVoiceId: jest.Mock };
  let config: { get: jest.Mock };
  let service: McKitsService;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-kits-'));
    await fs.mkdir(path.join(tmpDir, 'mascots'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'mascots', 'cutout.png'), Buffer.from('png-bytes'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    let seq = 0;
    kitRepo = {
      save: jest.fn((obj: Record<string, unknown>) =>
        Promise.resolve({ id: `kit-${++seq}`, referenceAssetIds: [], ...obj }),
      ),
      findOneBy: jest.fn(),
      findOneByOrFail: jest.fn((where: { id: string }) =>
        Promise.resolve({ id: where.id, referenceAssetIds: [] }),
      ),
      find: jest.fn().mockResolvedValue([]),
    };
    manager = {
      getRepository: jest.fn(() => kitRepo),
      save: jest.fn(),
      update: jest.fn(),
    };
    dataSource = {
      getRepository: jest.fn(() => kitRepo),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    queue = { publish: jest.fn().mockResolvedValue('job-1') };
    mascots = { findOne: jest.fn().mockResolvedValue({ ...mascotBase }) };
    moderation = {
      moderate: jest.fn().mockResolvedValue({ flagged: false, categories: [] }),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    // resolve passthrough: nos testes o voiceId de entrada já é o do provider
    voices = { resolveProviderVoiceId: jest.fn((v: string) => Promise.resolve(v)) };
    service = new McKitsService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      mascots as unknown as MascotsService,
      moderation as unknown as ModerationProvider,
      commercials as unknown as CommercialsService,
      voices as unknown as McVoicesService,
      config as unknown as ConfigService,
    );
  });

  it('mascote sem aceite de direitos → 422 MASCOT_RIGHTS_REQUIRED, sem moderação nem fila', async () => {
    mascots.findOne.mockResolvedValue({ ...mascotBase, rightsConfirmedAt: null });
    await expect(service.createKit('u1', { mascotId: 'mascot-1' })).rejects.toMatchObject({
      response: { code: 'MASCOT_RIGHTS_REQUIRED' },
    });
    expect(moderation.moderate).not.toHaveBeenCalled();
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('mascote sem imagem utilizável → 422 MASCOT_IMAGE_REQUIRED', async () => {
    mascots.findOne.mockResolvedValue({
      ...mascotBase,
      cutoutUrl: null,
      sourceImageUrl: null,
    });
    await expect(service.createKit('u1', { mascotId: 'mascot-1' })).rejects.toMatchObject({
      response: { code: 'MASCOT_IMAGE_REQUIRED' },
    });
    expect(queue.publish).not.toHaveBeenCalled();
  });

  it('arquivo da imagem sumiu do disco → 422 MASCOT_IMAGE_MISSING', async () => {
    mascots.findOne.mockResolvedValue({
      ...mascotBase,
      cutoutUrl: '/uploads/mascots/nao-existe.png',
      sourceImageUrl: null,
    });
    await expect(service.createKit('u1', { mascotId: 'mascot-1' })).rejects.toMatchObject({
      response: { code: 'MASCOT_IMAGE_MISSING' },
    });
  });

  it('moderação flagged → 422 MASCOT_MODERATION_BLOCKED; kit failed AUDITADO, nada na fila (§6.8)', async () => {
    moderation.moderate.mockResolvedValue({
      flagged: true,
      categories: ['violence'],
      raw: { results: [] },
    });
    await expect(service.createKit('u1', { mascotId: 'mascot-1' })).rejects.toMatchObject({
      response: { code: 'MASCOT_MODERATION_BLOCKED' },
    });
    // o kit nasce failed com o jsonb da moderação — trilha sem gasto de geração
    expect(kitRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: McKitStatus.FAILED,
        moderation: expect.objectContaining({ flagged: true, categories: ['violence'] }),
      }),
    );
    expect(queue.publish).not.toHaveBeenCalled();
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ refKind: 'kit', kind: 'moderation_blocked' }),
    );
  });

  it('caminho feliz: moderação ANTES da fila; kit generating; mc.image com expireInSeconds 300', async () => {
    const kit = await service.createKit('u1', { mascotId: 'mascot-1', voiceId: 'voice-9' });

    expect(moderation.moderate).toHaveBeenCalledWith(
      expect.objectContaining({ imageBase64: Buffer.from('png-bytes').toString('base64') }),
    );
    const moderateOrder = moderation.moderate.mock.invocationCallOrder[0];
    const publishOrder = queue.publish.mock.invocationCallOrder[0];
    expect(moderateOrder).toBeLessThan(publishOrder);

    expect(kit).toMatchObject({ status: McKitStatus.GENERATING, voiceId: 'voice-9' });
    expect(queue.publish).toHaveBeenCalledWith(
      QUEUES.MC_IMAGE,
      { kitId: kit.id },
      { expireInSeconds: MC_IMAGE_EXPIRE_S },
    );
    expect(MC_IMAGE_EXPIRE_S).toBe(300);
    // evento + notify no canal DEDICADO mc_events
    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.GENERATING },
      MC_EVENTS_CHANNEL,
    );
  });

  describe('approve', () => {
    const reviewKit = {
      id: 'kit-r',
      userId: 'u1',
      status: McKitStatus.REVIEW,
      voiceId: null,
      referenceAssetIds: [],
    };

    it('kit fora de review → 422 KIT_NOT_IN_REVIEW', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, status: McKitStatus.GENERATING });
      await expect(service.approveKit('u1', 'kit-r', {})).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_REVIEW' },
      });
    });

    it('sem voz definida (nem no kit nem no body) → 422 KIT_VOICE_REQUIRED', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await expect(service.approveKit('u1', 'kit-r', {})).rejects.toMatchObject({
        response: { code: 'KIT_VOICE_REQUIRED' },
      });
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('review → approved via CAS com approvedAt + voiceId do body', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });

      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-r',
        McKitStatus.REVIEW,
        McKitStatus.APPROVED,
        expect.objectContaining({ voiceId: 'voice-3', approvedAt: expect.any(Date) }),
      );
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        { kind: 'mc_kit', kitId: 'kit-r', status: McKitStatus.APPROVED },
        MC_EVENTS_CHANNEL,
      );
    });

    it('kit de outro usuário → 403', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, userId: 'u2' });
      await expect(service.approveKit('u1', 'kit-r', {})).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('regenerateReference', () => {
    it('kit fora de review → 422; nada enfileirado', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        id: 'kit-a',
        userId: 'u1',
        status: McKitStatus.APPROVED,
      });
      await expect(service.regenerateReference('u1', 'kit-a', { slot: 1 })).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_REVIEW' },
      });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('em review: enfileira {kitId, slot} com singletonKey anti-duplo-clique', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        id: 'kit-r',
        userId: 'u1',
        status: McKitStatus.REVIEW,
      });
      await expect(service.regenerateReference('u1', 'kit-r', { slot: 2 })).resolves.toEqual({
        queued: true,
        slot: 2,
      });
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        { kitId: 'kit-r', slot: 2 },
        expect.objectContaining({
          expireInSeconds: MC_IMAGE_EXPIRE_S,
          singletonKey: 'kit-regen:kit-r:2',
        }),
      );
    });
  });

  /**
   * v1.15 — a ficha da capivara veio com "carrega uma cesta de frutas" como
   * traço e "nunca remover a cesta" como regra: o prop da arte virava
   * identidade. O usuário precisa poder corrigir isso antes de refazer as
   * imagens (relato de uso).
   */
  describe('updateSheet — ficha editável na revisão', () => {
    const sheetV1 = JSON.stringify({
      traits: ['capybara character', 'carries a green shopping basket'],
      colors: ['#FF4500', '#32CD32'],
      style: '3D cartoon',
      doNots: ['never change the species', 'never remove the shopping basket'],
      pt: {
        traits: ['personagem capivara', 'carrega uma cesta de frutas'],
        doNots: ['nunca mudar a espécie', 'nunca remover a cesta'],
        style: 'cartoon 3D',
      },
    });
    const reviewKit = {
      id: 'kit-r',
      userId: 'u1',
      status: McKitStatus.REVIEW,
      canonicalDesc: sheetV1,
      referenceAssetIds: [],
    };

    /** JSON efetivamente gravado no update (a asserção real deste bloco). */
    const savedSheet = () =>
      JSON.parse((manager.update as jest.Mock).mock.calls[0][2].canonicalDesc as string) as Record<
        string,
        unknown
      >;

    it('kit fora de review → 422 e nada gravado (kit aprovado é imutável)', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, status: McKitStatus.APPROVED });
      await expect(service.updateSheet('u1', 'kit-r', { traits: [] })).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_REVIEW' },
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('promove a cesta de traço para acessório e some com a regra que a prendia', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await service.updateSheet('u1', 'kit-r', {
        traits: [{ en: 'capybara character', pt: 'personagem capivara' }],
        doNots: [{ en: 'never change the species', pt: 'nunca mudar a espécie' }],
        accessories: [{ en: 'green shopping basket', pt: 'cesta de frutas' }],
      });
      const saved = savedSheet();
      expect(saved.traits).toEqual(['capybara character']);
      expect(saved.doNots).toEqual(['never change the species']);
      expect(saved.accessories).toEqual(['green shopping basket']);
      expect((saved.pt as Record<string, string[]>).accessories).toEqual(['cesta de frutas']);
      // cores e estilo não foram enviados: seguem como estavam
      expect(saved.colors).toEqual(['#FF4500', '#32CD32']);
      expect(saved.style).toBe('3D cartoon');
    });

    it('sem chave da OpenAI o ajuste em pt-BR segue como está nos dois idiomas', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await service.updateSheet('u1', 'kit-r', { adjustments: 'Tire a cesta da mão dele' });
      const saved = savedSheet();
      expect(saved.adjustments).toBe('Tire a cesta da mão dele');
      expect((saved.pt as Record<string, string>).adjustments).toBe('Tire a cesta da mão dele');
    });

    it('registra evento sheet_updated e avisa a UI pelo SSE', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await service.updateSheet('u1', 'kit-r', { accessories: [{ en: 'basket' }] });
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'sheet_updated', refId: 'kit-r' }),
      );
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        expect.objectContaining({ kind: 'mc_kit', kitId: 'kit-r' }),
        MC_EVENTS_CHANNEL,
      );
    });

    it('traduzir ficha sem chave da OpenAI → 503 explícito em vez de erro genérico', async () => {
      // ficha legada: só inglês, sem espelho pt (é o caso que pede tradução)
      kitRepo.findOneBy.mockResolvedValue({
        ...reviewKit,
        canonicalDesc: JSON.stringify({
          traits: ['capybara character'],
          colors: [],
          style: '3D cartoon',
          doNots: ['never change the species'],
        }),
      });
      await expect(service.translateSheet('u1', 'kit-r')).rejects.toMatchObject({
        response: { code: 'TRANSLATION_UNAVAILABLE' },
      });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('ficha já traduzida não gasta chamada de tradução (idempotente)', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...reviewKit,
        canonicalDesc: JSON.stringify({
          traits: ['capybara'],
          colors: [],
          style: '3D',
          doNots: [],
          pt: { traits: ['capivara'] },
        }),
      });
      await expect(service.translateSheet('u1', 'kit-r')).resolves.toBeDefined();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('item sem tradução usa o próprio texto no espelho pt (nunca fica vazio na tela)', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await service.updateSheet('u1', 'kit-r', { traits: [{ en: 'red apron' }] });
      expect((savedSheet().pt as Record<string, string[]>).traits).toEqual(['red apron']);
    });
  });
});
