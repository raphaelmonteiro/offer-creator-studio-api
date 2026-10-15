import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { ModerationProvider } from '../../../shared/providers/moderation.provider';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { ClientsService } from '../../clients/clients.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McKitProviderCost } from '../domain/mc-kit-costs';
import { McMouthVerdict } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitCandidatesService } from './mc-kit-candidates.service';
import { McKitTileService } from './mc-kit-tile.service';
import { McKitViewService } from './mc-kit-view.service';
import { MC_IMAGE_EXPIRE_S, McKitsService } from './mc-kits.service';
import { McMouthGateService } from './mc-mouth-gate.service';
import { McStorageService } from './mc-storage.service';
import { McVoicesService } from './mc-voices.service';

const passedVerdict: McMouthVerdict = {
  hasMouth: true,
  mouthOpenPossible: true,
  confidence: 0.92,
  bbox: { x: 0.3, y: 0.15, w: 0.4, h: 0.4 },
  model: 'mock',
  at: '2026-10-12T00:00:00.000Z',
};
const blockedVerdict: McMouthVerdict = { ...passedVerdict, mouthOpenPossible: false };
const undecidedVerdict: McMouthVerdict = { ...passedVerdict, confidence: 0.4 };
/** Linha de custo de uma visão do gate (tarefa 2.6). */
const gateCost: McKitProviderCost = {
  call: 'mouth_gate',
  provider: 'gemini',
  model: 'gemini-3.8-flash',
  usage: { inputTokens: 1200, outputTokens: 300, images: 0 },
  costUsd: 0.0015,
  rate: null,
};

describe('McKitsService — fluxo real do kit (plano §4/§6.8)', () => {
  let tmpDir: string;
  const mascotBase = {
    id: 'mascot-1',
    rightsConfirmedAt: new Date(),
    cutoutUrl: '/uploads/mascots/cutout.png',
    sourceImageUrl: '/uploads/mascots/source.png',
  };

  let manager: {
    getRepository: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    increment: jest.Mock;
  };
  let kitRepo: {
    save: jest.Mock;
    findOneBy: jest.Mock;
    findOneByOrFail: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
  };
  let assetRepo: { findOneBy: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let mascots: { findOne: jest.Mock; createFromUrl: jest.Mock };
  let moderation: { moderate: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let voices: { resolveProviderVoiceId: jest.Mock };
  let config: { get: jest.Mock };
  let clients: { findOne: jest.Mock };
  let view: {
    findOwned: jest.Mock;
    findOne: jest.Mock;
    toView: jest.Mock;
    resolveIdentityAsset: jest.Mock;
  };
  let candidates: {
    openRound: jest.Mock;
    publishRound: jest.Mock;
    translateAdjustments: jest.Mock;
  };
  /** Marca o COMMIT da transação simulada: a fila só pode ser tocada depois dele (L1). */
  let committed: jest.Mock;
  let mouthGate: { inspect: jest.Mock; inspectWithCost: jest.Mock };
  let tile: { build: jest.Mock; discard: jest.Mock };
  let service: McKitsService;
  /** Origem mascote com estilo — o mínimo que gera referências (STYLE_REQUIRED sem o estilo). */
  const mascotDto = {
    source: 'mascot' as const,
    style: 'cartoon_2d' as const,
    mascotId: 'mascot-1',
  };

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
      update: jest.fn().mockResolvedValue(undefined),
    };
    assetRepo = { findOneBy: jest.fn().mockResolvedValue(null) };
    manager = {
      getRepository: jest.fn(() => kitRepo),
      save: jest.fn(),
      update: jest.fn(),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === AnimationAsset ? assetRepo : kitRepo,
      ),
      transaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) => {
        const result = await cb(manager as unknown as EntityManager);
        committed();
        return result;
      }),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    queue = { publish: jest.fn().mockResolvedValue('job-1') };
    mascots = {
      findOne: jest.fn().mockResolvedValue({ ...mascotBase }),
      createFromUrl: jest.fn(),
    };
    clients = { findOne: jest.fn() };
    moderation = {
      moderate: jest.fn().mockResolvedValue({ flagged: false, categories: [] }),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    // resolve passthrough: nos testes o voiceId de entrada já é o do provider
    voices = {
      resolveProviderVoiceId: jest.fn((_userId: string, v: string) => Promise.resolve(v)),
    };
    // Leitura do kit (ownership 404/403) como o McKitViewService real faria sobre o repo mockado.
    view = {
      findOwned: jest.fn(async (userId: string, id: string) => {
        const kit = await kitRepo.findOneBy({ id });
        if (!kit) throw new NotFoundException('Kit não encontrado');
        if (kit.userId !== userId) throw new ForbiddenException();
        return kit;
      }),
      findOne: jest.fn(async (userId: string, id: string) => ({
        ...(await view.findOwned(userId, id)),
        references: [],
      })),
      toView: jest.fn(async (kit: McCharacterKit) => ({ ...kit, references: [] })),
      resolveIdentityAsset: jest.fn().mockResolvedValue({
        id: 'front-1',
        fileUrl: '/uploads/mascots/cutout.png',
        metadata: { slot: 2 },
      }),
    };
    candidates = {
      openRound: jest.fn().mockResolvedValue({
        roundId: 'round-1',
        count: 4,
        job: { kitId: 'kit-1', candidates: true, roundId: 'round-1' },
      }),
      publishRound: jest.fn().mockResolvedValue(undefined),
      translateAdjustments: jest.fn((text: string) => Promise.resolve(text)),
    };
    committed = jest.fn();
    // inspectWithCost delega ao inspect (os testes trocam o veredito nele); custo null = mock
    mouthGate = {
      inspect: jest.fn().mockResolvedValue(passedVerdict),
      inspectWithCost: jest.fn(async (image: Buffer) => ({
        verdict: await mouthGate.inspect(image),
        cost: null,
      })),
    };
    tile = {
      build: jest.fn().mockResolvedValue({
        assetId: 'tile-1',
        url: '/uploads/commercials/kits/kit-r/tile.png',
        width: 720,
        height: 960,
        ratio: 0.75,
        faceFraction: 0.6,
        backgroundColor: '#E5E7EB',
        hasAlpha: false,
      }),
      discard: jest.fn().mockResolvedValue(undefined),
    };
    service = new McKitsService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      mascots as unknown as MascotsService,
      moderation as unknown as ModerationProvider,
      commercials as unknown as CommercialsService,
      voices as unknown as McVoicesService,
      config as unknown as ConfigService,
      clients as unknown as ClientsService,
      view as unknown as McKitViewService,
      candidates as unknown as McKitCandidatesService,
      mouthGate as unknown as McMouthGateService,
      tile as unknown as McKitTileService,
      new McStorageService(config as unknown as ConfigService),
    );
  });

  it('mascote sem aceite de direitos → 422 MASCOT_RIGHTS_REQUIRED, sem moderação nem fila', async () => {
    mascots.findOne.mockResolvedValue({ ...mascotBase, rightsConfirmedAt: null });
    await expect(service.createKit('u1', mascotDto)).rejects.toMatchObject({
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
    await expect(service.createKit('u1', mascotDto)).rejects.toMatchObject({
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
    await expect(service.createKit('u1', mascotDto)).rejects.toMatchObject({
      response: { code: 'MASCOT_IMAGE_MISSING' },
    });
  });

  it('moderação flagged → 422 MASCOT_MODERATION_BLOCKED; kit failed AUDITADO, nada na fila (§6.8)', async () => {
    moderation.moderate.mockResolvedValue({
      flagged: true,
      categories: ['violence'],
      raw: { results: [] },
    });
    await expect(service.createKit('u1', mascotDto)).rejects.toMatchObject({
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

  it('caminho feliz: moderação ANTES da fila; kit generating; mc.image com expiração acima da soma dos timeouts (660 s)', async () => {
    const kit = await service.createKit('u1', { ...mascotDto, voiceId: 'voice-9' });

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
    // descrição e 4 referências no pior caso com re-tentativas + folga (2.6: com
    // 300 s o job expirava no meio da geração e as referências eram pagas de novo)
    expect(MC_IMAGE_EXPIRE_S).toBe(1380);
    // o job sai DEPOIS do commit (L1): consumido antes, não acharia o kit
    expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
      queue.publish.mock.invocationCallOrder[0],
    );
    // evento + notify no canal DEDICADO mc_events
    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.GENERATING },
      MC_EVENTS_CHANNEL,
    );
  });

  /**
   * Change video-formatos-personagem (D5): o kit nasce de um mascote OU do
   * logo da marca; o estilo é exigido para gerar referências; o logo precisa
   * dos direitos da marca; só a origem logo passa por candidatos (2.4).
   */
  describe('origem e estilo (D5) — createKit por origem', () => {
    const logoBase = {
      id: 'logo-1',
      kind: 'logo',
      clientId: 'c1',
      rightsConfirmedAt: new Date(),
      cutoutUrl: null,
      sourceImageUrl: '/uploads/mascots/cutout.png',
    };

    it('mascote sem estilo → 422 STYLE_REQUIRED antes de moderar (gerar referência exige estilo)', async () => {
      await expect(
        service.createKit('u1', { source: 'mascot', mascotId: 'mascot-1' }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'STYLE_REQUIRED' } });
      expect(moderation.moderate).not.toHaveBeenCalled();
      expect(kitRepo.save).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('mascote com estilo → kit generating com source/style/identityMode, job de referência e SEM rodada de candidatos', async () => {
      const kit = await service.createKit('u1', { ...mascotDto, style: '3d_render' });
      expect(kitRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'mascot',
          style: '3d_render',
          identityMode: 'generated',
          mascotId: 'mascot-1',
          status: McKitStatus.GENERATING,
        }),
      );
      expect(queue.publish).toHaveBeenCalledTimes(1);
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        { kitId: kit.id },
        { expireInSeconds: MC_IMAGE_EXPIRE_S },
      );
      expect(kit.candidateRoundId ?? null).toBeNull();
      expect(mascots.createFromUrl).not.toHaveBeenCalled();
      expect(clients.findOne).not.toHaveBeenCalled();
    });

    it('mascotId que aponta para um logo → 422 MASCOT_KIND_MISMATCH', async () => {
      mascots.findOne.mockResolvedValue({ ...mascotBase, kind: 'logo' });
      await expect(service.createKit('u1', mascotDto)).rejects.toMatchObject({
        response: { code: 'MASCOT_KIND_MISMATCH' },
      });
    });

    it('logo por clientId: registra o logo via createFromUrl; sem direitos → 422 LOGO_RIGHTS_REQUIRED com o mascotId', async () => {
      clients.findOne.mockResolvedValue({
        id: 'c1',
        name: 'Mercado Bom',
        logoUrl: 'http://cdn/uploads/logos/l.png',
      });
      mascots.createFromUrl.mockResolvedValue({ ...logoBase, rightsConfirmedAt: null });
      await expect(
        service.createKit('u1', { source: 'logo', clientId: 'c1', style: 'cartoon_2d' }),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'LOGO_RIGHTS_REQUIRED', mascotId: 'logo-1' },
      });
      expect(mascots.createFromUrl).toHaveBeenCalledWith('u1', 'http://cdn/uploads/logos/l.png', {
        name: 'Logo Mercado Bom',
        clientId: 'c1',
        kind: 'logo',
        rightsConfirmed: false,
      });
      expect(moderation.moderate).not.toHaveBeenCalled();
      expect(kitRepo.save).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('logo por clientId com rightsConfirmed: kit generating com source logo, gate de boca no logo cru e a PRIMEIRA rodada de candidatos aberta — nenhuma referência enfileirada (D4)', async () => {
      clients.findOne.mockResolvedValue({
        id: 'c1',
        name: 'Mercado Bom',
        logoUrl: '/uploads/logos/l.png',
      });
      mascots.createFromUrl.mockResolvedValue({ ...logoBase });
      const kit = await service.createKit('u1', {
        source: 'logo',
        clientId: 'c1',
        style: '3d_render',
        rightsConfirmed: true,
      });
      expect(mascots.createFromUrl).toHaveBeenCalledWith(
        'u1',
        '/uploads/logos/l.png',
        expect.objectContaining({ kind: 'logo', rightsConfirmed: true }),
      );
      expect(kit).toMatchObject({
        status: McKitStatus.GENERATING,
        source: 'logo',
        style: '3d_render',
        identityMode: 'generated',
        mascotId: 'logo-1',
        tileBackgroundColor: '#E5E7EB',
        candidateRoundId: 'round-1',
      });
      // gate de boca rodou no logo cru e ficou gravado no kit
      expect(mouthGate.inspect).toHaveBeenCalledTimes(1);
      expect(kit.mouthGate).toEqual({ logo: passedVerdict });
      expect(moderation.moderate).toHaveBeenCalledTimes(1);
      // a rodada de candidatos é quem publica o job — nada de {kitId} de referências
      expect(candidates.openRound).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ id: kit.id, source: 'logo', style: '3d_render' }),
        { kind: 'mascotization' },
      );
      expect(queue.publish).not.toHaveBeenCalled();
      // o job da rodada é publicado DEPOIS do commit (L1)
      expect(candidates.publishRound).toHaveBeenCalledWith({
        kitId: 'kit-1',
        candidates: true,
        roundId: 'round-1',
      });
      expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
        candidates.publishRound.mock.invocationCallOrder[0],
      );
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        { kind: 'mc_kit', kitId: kit.id, status: McKitStatus.GENERATING },
        MC_EVENTS_CHANNEL,
      );
    });

    it('gate de boca no logo cru é pago antes de o kit existir: custo na soma já no INSERT e uma linha provider_cost, sem incremento duplicado (2.6)', async () => {
      clients.findOne.mockResolvedValue({
        id: 'c1',
        name: 'Mercado Bom',
        logoUrl: '/uploads/logos/l.png',
      });
      mascots.createFromUrl.mockResolvedValue({ ...logoBase });
      mouthGate.inspectWithCost.mockResolvedValue({ verdict: passedVerdict, cost: gateCost });
      const kit = await service.createKit('u1', {
        source: 'logo',
        clientId: 'c1',
        style: '3d_render',
        rightsConfirmed: true,
      });
      expect(kitRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: McKitStatus.GENERATING,
          providerCostUsd: 0.0015,
          mouthGate: { logo: passedVerdict },
        }),
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          refKind: 'kit',
          refId: kit.id,
          kind: 'provider_cost',
          detail: expect.objectContaining({
            call: 'mouth_gate',
            model: 'gemini-3.8-flash',
            costUsd: 0.0015,
            target: 'logo',
          }),
        }),
      );
      expect(manager.increment).not.toHaveBeenCalled();
    });

    it('origem mascote não chama o gate na criação: kit nasce com custo 0 (default da coluna), sem linha de custo', async () => {
      await service.createKit('u1', mascotDto);
      expect(mouthGate.inspectWithCost).not.toHaveBeenCalled();
      expect(kitRepo.save).toHaveBeenCalledWith(
        expect.not.objectContaining({ providerCostUsd: expect.anything() }),
      );
      expect(commercials.appendEvent).not.toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'provider_cost' }),
      );
    });

    it('logo sem estilo → 422 STYLE_REQUIRED antes de moderar (candidatos são gerados no estilo do kit)', async () => {
      mascots.findOne.mockResolvedValue({ ...logoBase });
      await expect(
        service.createKit('u1', { source: 'logo', logoMascotId: 'logo-1' }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'STYLE_REQUIRED' } });
      expect(moderation.moderate).not.toHaveBeenCalled();
      expect(candidates.openRound).not.toHaveBeenCalled();
      expect(kitRepo.save).not.toHaveBeenCalled();
    });

    it('cor de marca pedida na criação vira o fundo liso dos candidatos e do tile', async () => {
      mascots.findOne.mockResolvedValue({ ...logoBase });
      const kit = await service.createKit('u1', {
        source: 'logo',
        logoMascotId: 'logo-1',
        style: 'cartoon_2d',
        tileBackgroundColor: '#ffcc00',
      });
      expect(kit.tileBackgroundColor).toBe('#FFCC00');
    });

    it('cliente sem logo cadastrado → 422 CLIENT_LOGO_REQUIRED', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', name: 'Mercado', logoUrl: null });
      await expect(
        service.createKit('u1', { source: 'logo', clientId: 'c1', style: 'cartoon_2d' }),
      ).rejects.toMatchObject({ response: { code: 'CLIENT_LOGO_REQUIRED' } });
      expect(mascots.createFromUrl).not.toHaveBeenCalled();
    });

    it('logo por clientId SEM estilo → 422 STYLE_REQUIRED antes de registrar o logo (nenhum efeito colateral) (L4)', async () => {
      clients.findOne.mockResolvedValue({ id: 'c1', name: 'Mercado', logoUrl: '/uploads/l.png' });
      await expect(
        service.createKit('u1', { source: 'logo', clientId: 'c1', rightsConfirmed: true }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'STYLE_REQUIRED' } });
      expect(clients.findOne).not.toHaveBeenCalled();
      expect(mascots.createFromUrl).not.toHaveBeenCalled();
      expect(mascots.findOne).not.toHaveBeenCalled();
      expect(moderation.moderate).not.toHaveBeenCalled();
      expect(kitRepo.save).not.toHaveBeenCalled();
    });

    it('logoMascotId: precisa ser kind logo (422 MASCOT_KIND_MISMATCH) e ter direitos (LOGO_RIGHTS_REQUIRED)', async () => {
      mascots.findOne.mockResolvedValue({ ...mascotBase, kind: 'mascot' });
      await expect(
        service.createKit('u1', { source: 'logo', logoMascotId: 'mascot-1', style: 'cartoon_2d' }),
      ).rejects.toMatchObject({ response: { code: 'MASCOT_KIND_MISMATCH' } });

      mascots.findOne.mockResolvedValue({ ...logoBase, rightsConfirmedAt: null });
      await expect(
        service.createKit('u1', { source: 'logo', logoMascotId: 'logo-1', style: 'cartoon_2d' }),
      ).rejects.toMatchObject({ response: { code: 'LOGO_RIGHTS_REQUIRED', mascotId: 'logo-1' } });

      mascots.findOne.mockResolvedValue({ ...logoBase });
      const kit = await service.createKit('u1', {
        source: 'logo',
        logoMascotId: 'logo-1',
        style: 'cartoon_2d',
      });
      expect(kit).toMatchObject({ source: 'logo', mascotId: 'logo-1' });
      expect(clients.findOne).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
      expect(candidates.openRound).toHaveBeenCalledTimes(1);
    });

    it('logo: clientId e logoMascotId juntos → LOGO_SOURCE_AMBIGUOUS; nenhum → LOGO_SOURCE_REQUIRED', async () => {
      await expect(
        service.createKit('u1', {
          source: 'logo',
          clientId: 'c1',
          logoMascotId: 'logo-1',
          style: 'cartoon_2d',
        }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'LOGO_SOURCE_AMBIGUOUS' } });
      await expect(
        service.createKit('u1', { source: 'logo', style: 'cartoon_2d' }),
      ).rejects.toMatchObject({
        status: 422,
        response: { code: 'LOGO_SOURCE_REQUIRED' },
      });
      expect(mascots.findOne).not.toHaveBeenCalled();
      expect(clients.findOne).not.toHaveBeenCalled();
    });
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
        expect.objectContaining({ sql: expect.any(String) }),
      );
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        { kind: 'mc_kit', kitId: 'kit-r', status: McKitStatus.APPROVED },
        MC_EVENTS_CHANNEL,
      );
    });

    it('ajuste de entrega (velocidade/expressividade) do body é gravado no kit, já clampado', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await service.approveKit('u1', 'kit-r', {
        voiceId: 'voice-3',
        delivery: { speed: 1.9, style: 0.8 },
      });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-r',
        McKitStatus.REVIEW,
        McKitStatus.APPROVED,
        expect.objectContaining({ voiceDelivery: { speed: 1.2, style: 0.8 } }),
        expect.objectContaining({ sql: expect.any(String) }),
      );
    });

    it('sem ajuste no body mantém o do kit; ajuste vazio vira null (usa o global)', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, voiceDelivery: { speed: 1.0 } });
      await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
      expect(transitions.casTransition).toHaveBeenLastCalledWith(
        manager,
        McCharacterKit,
        'kit-r',
        McKitStatus.REVIEW,
        McKitStatus.APPROVED,
        expect.objectContaining({ voiceDelivery: { speed: 1.0 } }),
        expect.objectContaining({ sql: expect.any(String) }),
      );
      await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3', delivery: {} });
      expect(transitions.casTransition).toHaveBeenLastCalledWith(
        manager,
        McCharacterKit,
        'kit-r',
        McKitStatus.REVIEW,
        McKitStatus.APPROVED,
        expect.objectContaining({ voiceDelivery: null }),
        expect.objectContaining({ sql: expect.any(String) }),
      );
    });

    it('kit de outro usuário → 403', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, userId: 'u2' });
      await expect(service.approveKit('u1', 'kit-r', {})).rejects.toMatchObject({ status: 403 });
    });

    /**
     * Gate de boca e tile na aprovação (D1/D4, spec video-character-kit
     * "Gate de boca legível" e "Tile do personagem").
     */
    describe('gate de boca e tile', () => {
      it('visão paga na aprovação: custo registrado no kit (evento + soma) mesmo quando a aprovação recusa; veredito reaproveitado não paga de novo (2.6)', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        mouthGate.inspectWithCost.mockResolvedValue({ verdict: blockedVerdict, cost: gateCost });
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({ response: { code: 'MOUTH_NOT_LEGIBLE' } });
        expect(commercials.appendEvent).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({
            refId: 'kit-r',
            kind: 'provider_cost',
            detail: expect.objectContaining({
              call: 'mouth_gate',
              costUsd: 0.0015,
              target: 'identity',
              identityAssetId: 'front-1',
            }),
          }),
        );
        expect(manager.increment).toHaveBeenCalledWith(
          McCharacterKit,
          { id: 'kit-r' },
          'providerCostUsd',
          0.0015,
        );

        // veredito já gravado para a MESMA identidade: nenhuma visão, nenhum custo novo
        mouthGate.inspectWithCost.mockClear();
        manager.increment.mockClear();
        kitRepo.findOneBy.mockResolvedValue({
          ...reviewKit,
          mouthGate: { identity: { ...passedVerdict, identityAssetId: 'front-1' } },
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(mouthGate.inspectWithCost).not.toHaveBeenCalled();
        expect(manager.increment).not.toHaveBeenCalled();
      });

      it('boca legível: tile gerado da identidade; identityAssetId/tileAssetId/cor/veredito gravados no kit aprovado', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });

        expect(mouthGate.inspect).toHaveBeenCalledTimes(1);
        expect(tile.build).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'kit-r' }),
          expect.objectContaining({ id: 'front-1' }),
          passedVerdict.bbox,
        );
        expect(transitions.casTransition).toHaveBeenCalledWith(
          manager,
          McCharacterKit,
          'kit-r',
          McKitStatus.REVIEW,
          McKitStatus.APPROVED,
          expect.objectContaining({
            identityAssetId: 'front-1',
            tileAssetId: 'tile-1',
            tileBackgroundColor: '#E5E7EB',
            mouthGate: { identity: { ...passedVerdict, identityAssetId: 'front-1' } },
          }),
          expect.objectContaining({ sql: expect.any(String) }),
        );
      });

      it('boca de traço único → 422 MOUTH_NOT_LEGIBLE com a ação de variante; veredito gravado; kit segue em review', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        mouthGate.inspect.mockResolvedValue(blockedVerdict);
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({
          status: 422,
          response: {
            code: 'MOUTH_NOT_LEGIBLE',
            details: expect.objectContaining({ actions: ['mouth_variant', 'choose_candidate'] }),
          },
        });
        expect(kitRepo.update).toHaveBeenCalledWith(
          { id: 'kit-r', status: McKitStatus.REVIEW },
          { mouthGate: { identity: { ...blockedVerdict, identityAssetId: 'front-1' } } },
        );
        expect(tile.build).not.toHaveBeenCalled();
        expect(transitions.casTransition).not.toHaveBeenCalled();
      });

      it('variante com boca escolhida (identidade nova) → gate roda de novo na nova identidade e aprova', async () => {
        kitRepo.findOneBy.mockResolvedValue({
          ...reviewKit,
          identityAssetId: 'variant-1',
          mouthGate: { identity: { ...blockedVerdict, identityAssetId: 'front-1' } },
        });
        view.resolveIdentityAsset.mockResolvedValue({
          id: 'variant-1',
          fileUrl: '/uploads/mascots/cutout.png',
        });
        mouthGate.inspect.mockResolvedValue(passedVerdict);
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(mouthGate.inspect).toHaveBeenCalledTimes(1); // veredito antigo era de outra identidade
        expect(transitions.casTransition).toHaveBeenCalledWith(
          manager,
          McCharacterKit,
          'kit-r',
          McKitStatus.REVIEW,
          McKitStatus.APPROVED,
          expect.objectContaining({
            identityAssetId: 'variant-1',
            mouthGate: { identity: { ...passedVerdict, identityAssetId: 'variant-1' } },
          }),
          expect.objectContaining({ sql: expect.any(String) }),
        );
      });

      it('resposta da visão PAGA e ilegível (`paid`): o aceite de risco reaproveita o veredito, sem pagar a visão de novo; visão indisponível (sem `paid`) é inspecionada outra vez', async () => {
        const garbled: McMouthVerdict = {
          hasMouth: false,
          mouthOpenPossible: false,
          confidence: 0,
          bbox: null,
          model: 'gemini-3.8-flash',
          at: '2026-10-15T12:00:00Z',
          error: 'resposta não interpretável',
          paid: true,
        };
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        mouthGate.inspectWithCost.mockResolvedValueOnce({ verdict: garbled, cost: gateCost });
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({ response: { code: 'MOUTH_GATE_UNDECIDED' } });
        expect(mouthGate.inspectWithCost).toHaveBeenCalledTimes(1);
        expect(kitRepo.update).toHaveBeenCalledWith(
          { id: 'kit-r', status: McKitStatus.REVIEW },
          { mouthGate: { identity: { ...garbled, identityAssetId: 'front-1' } } },
        );

        // o usuário aceita o risco: mesmo asset, veredito pago → nenhuma visão nem custo novo
        mouthGate.inspectWithCost.mockClear();
        manager.increment.mockClear();
        kitRepo.findOneBy.mockResolvedValue({
          ...reviewKit,
          mouthGate: { identity: { ...garbled, identityAssetId: 'front-1' } },
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3', acceptMouthRisk: true });
        expect(mouthGate.inspectWithCost).not.toHaveBeenCalled();
        expect(manager.increment).not.toHaveBeenCalled();

        // visão que NÃO respondeu (error sem paid): re-inspeciona
        transitions.casTransition.mockClear();
        const { paid: _paid, ...unavailable } = { ...garbled, error: 'HTTP 503' };
        kitRepo.findOneBy.mockResolvedValue({
          ...reviewKit,
          mouthGate: { identity: { ...unavailable, identityAssetId: 'front-1' } },
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(mouthGate.inspectWithCost).toHaveBeenCalledTimes(1);
      });

      it('resultado incerto: sem acceptMouthRisk → 422 MOUTH_GATE_UNDECIDED; com ele aprova e registra o aceite', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        mouthGate.inspect.mockResolvedValue(undecidedVerdict);
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({
          status: 422,
          response: {
            code: 'MOUTH_GATE_UNDECIDED',
            // spec "Resultado incerto": "aceitar o risco" e "gerar variante com boca"
            details: expect.objectContaining({ actions: ['accept_mouth_risk', 'mouth_variant'] }),
          },
        });
        expect(transitions.casTransition).not.toHaveBeenCalled();

        // segunda tentativa: o veredito da MESMA identidade já está no kit — não roda visão de novo
        kitRepo.findOneBy.mockResolvedValue({
          ...reviewKit,
          mouthGate: { identity: { ...undecidedVerdict, identityAssetId: 'front-1' } },
        });
        mouthGate.inspect.mockClear();
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3', acceptMouthRisk: true });
        expect(mouthGate.inspect).not.toHaveBeenCalled();
        const patch = transitions.casTransition.mock.calls[0][5] as {
          mouthGate: { riskAccepted: { identityAssetId: string; confidence: number } };
        };
        expect(patch.mouthGate.riskAccepted).toMatchObject({
          identityAssetId: 'front-1',
          confidence: 0.4,
        });
        expect(commercials.appendEvent).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({
            toStatus: McKitStatus.APPROVED,
            detail: expect.objectContaining({ mouthGate: 'undecided', riskAccepted: true }),
          }),
        );
      });

      it('borda do tile não uniforme → 422 TILE_BORDER_NOT_UNIFORM; kit fica em review com o veredito gravado', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        tile.build.mockRejectedValue(
          new UnprocessableEntityException({ code: 'TILE_BORDER_NOT_UNIFORM', message: 'x' }),
        );
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'TILE_BORDER_NOT_UNIFORM' },
        });
        expect(transitions.casTransition).not.toHaveBeenCalled();
        expect(kitRepo.update).toHaveBeenCalledWith(
          { id: 'kit-r', status: McKitStatus.REVIEW },
          { mouthGate: { identity: { ...passedVerdict, identityAssetId: 'front-1' } } },
        );
      });

      it('tile já gerado para a MESMA identidade é reaproveitado; identidade diferente → tile novo', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, tileAssetId: 'tile-old' });
        assetRepo.findOneBy.mockResolvedValue({
          id: 'tile-old',
          metadata: { identityAssetId: 'front-1', backgroundColor: '#ABCDEF' },
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(tile.build).not.toHaveBeenCalled();
        expect(transitions.casTransition).toHaveBeenCalledWith(
          manager,
          McCharacterKit,
          'kit-r',
          McKitStatus.REVIEW,
          McKitStatus.APPROVED,
          expect.objectContaining({ tileAssetId: 'tile-old', tileBackgroundColor: '#ABCDEF' }),
          expect.objectContaining({ sql: expect.any(String) }),
        );

        // tile antigo pertence a outra identidade (trocada em revisão): regera
        assetRepo.findOneBy.mockResolvedValue({
          id: 'tile-old',
          metadata: { identityAssetId: 'other', backgroundColor: '#ABCDEF' },
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(tile.build).toHaveBeenCalledTimes(1);
      });

      it('kit sem identidade (sem referência frontal e sem candidato) → 422 KIT_IDENTITY_MISSING', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        view.resolveIdentityAsset.mockResolvedValue(null);
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({
          status: 422,
          response: { code: 'KIT_IDENTITY_MISSING' },
        });
        expect(mouthGate.inspect).not.toHaveBeenCalled();
      });

      /** M1: o veredito do logo cru gravado por "usar como está" é o da identidade — sem segunda visão. */
      it('logo como está: veredito já gravado em mouthGate.identity é reaproveitado (sem visão) e o tile usa a caixa dele', async () => {
        const logoGate = {
          logo: passedVerdict,
          identity: { ...passedVerdict, identityAssetId: 'asset-logo' },
        };
        kitRepo.findOneBy.mockResolvedValue({
          ...reviewKit,
          source: 'logo',
          identityMode: 'logo_as_is',
          identityAssetId: 'asset-logo',
          mouthGate: logoGate,
        });
        view.resolveIdentityAsset.mockResolvedValue({
          id: 'asset-logo',
          fileUrl: '/uploads/mascots/cutout.png',
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(mouthGate.inspect).not.toHaveBeenCalled();
        expect(tile.build).toHaveBeenCalledWith(
          expect.objectContaining({ identityMode: 'logo_as_is' }),
          expect.objectContaining({ id: 'asset-logo' }),
          passedVerdict.bbox,
        );
        expect(transitions.casTransition).toHaveBeenCalledWith(
          manager,
          McCharacterKit,
          'kit-r',
          McKitStatus.REVIEW,
          McKitStatus.APPROVED,
          expect.objectContaining({ identityAssetId: 'asset-logo', mouthGate: logoGate }),
          { sql: '"identityAssetId" = :identityId', params: { identityId: 'asset-logo' } },
        );
      });

      /** M4: identidade gerada sem caixa do rosto → o tile recusa; kit fica em revisão com o veredito. */
      it('tile sem rosto localizável → 422 TILE_FACE_NOT_FOUND com as ações; veredito gravado; nada aprovado', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        tile.build.mockRejectedValue(
          new UnprocessableEntityException({
            code: 'TILE_FACE_NOT_FOUND',
            message: 'x',
            details: { actions: ['mouth_variant', 'choose_candidate'] },
          }),
        );
        await expect(
          service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
        ).rejects.toMatchObject({
          status: 422,
          response: {
            code: 'TILE_FACE_NOT_FOUND',
            details: { actions: ['mouth_variant', 'choose_candidate'] },
          },
        });
        expect(transitions.casTransition).not.toHaveBeenCalled();
        expect(kitRepo.update).toHaveBeenCalledWith(
          { id: 'kit-r', status: McKitStatus.REVIEW },
          { mouthGate: { identity: { ...passedVerdict, identityAssetId: 'front-1' } } },
        );
      });

      /** M4: a fração do rosto medida no tile fica auditada no evento de aprovação. */
      it('evento de aprovação leva faceFraction do tile (gerado agora ou reaproveitado)', async () => {
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(commercials.appendEvent).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({
            toStatus: McKitStatus.APPROVED,
            detail: expect.objectContaining({ faceFraction: 0.6, tileAssetId: 'tile-1' }),
          }),
        );
        kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, tileAssetId: 'tile-old' });
        assetRepo.findOneBy.mockResolvedValue({
          id: 'tile-old',
          metadata: { identityAssetId: 'front-1', backgroundColor: '#ABCDEF', faceFraction: 0.55 },
        });
        await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
        expect(commercials.appendEvent).toHaveBeenLastCalledWith(
          manager,
          expect.objectContaining({
            detail: expect.objectContaining({ faceFraction: 0.55, tileAssetId: 'tile-old' }),
          }),
        );
      });

      /** M5: a aprovação assina a identidade vista pelo gate/tile na MESMA UPDATE do CAS. */
      describe('corrida da identidade (M5)', () => {
        it('kit de mascote (identidade = frontal): a condição extra exige identityAssetId nulo e a frontal ainda nas referências', async () => {
          kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, referenceAssetIds: ['front-1'] });
          await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
          const extra = transitions.casTransition.mock.calls[0][6] as {
            sql: string;
            params: unknown;
          };
          expect(extra.sql).toMatch(/"identityAssetId" IS NULL/);
          expect(extra.sql).toMatch(/ANY\("referenceAssetIds"\)/);
          expect(extra.params).toEqual({ identityId: 'front-1' });
        });

        it('kit com identityAssetId (candidato): a condição extra exige o mesmo identityAssetId', async () => {
          kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, identityAssetId: 'cand-1' });
          view.resolveIdentityAsset.mockResolvedValue({
            id: 'cand-1',
            fileUrl: '/uploads/mascots/cutout.png',
          });
          await service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' });
          const extra = transitions.casTransition.mock.calls[0][6] as {
            sql: string;
            params: unknown;
          };
          expect(extra).toEqual({
            sql: '"identityAssetId" = :identityId',
            params: { identityId: 'cand-1' },
          });
        });

        it('CAS perdido com o kit ainda em review (identidade trocada) → 422 KIT_IDENTITY_CHANGED e o tile recém-gerado é descartado', async () => {
          kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
          transitions.casTransition.mockResolvedValue(false);
          await expect(
            service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
          ).rejects.toMatchObject({
            status: 422,
            response: { code: 'KIT_IDENTITY_CHANGED' },
          });
          expect(tile.build).toHaveBeenCalledTimes(1);
          expect(tile.discard).toHaveBeenCalledWith(manager, 'tile-1');
          // descarte numa transação PRÓPRIA, depois da perdedora: descartar dentro
          // dela e lançar o 422 desfaria o descarte junto (rollback)
          expect(committed).toHaveBeenCalledTimes(2);
          expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
            tile.discard.mock.invocationCallOrder[0],
          );
          expect(commercials.appendEvent).not.toHaveBeenCalledWith(
            manager,
            expect.objectContaining({ toStatus: McKitStatus.APPROVED }),
          );
        });

        it('CAS perdido com o kit fora de review → 422 KIT_NOT_IN_REVIEW (tile novo descartado; tile reaproveitado fica)', async () => {
          kitRepo.findOneBy
            .mockResolvedValueOnce({ ...reviewKit }) // leitura inicial (findOwned)
            .mockResolvedValue({ ...reviewKit, status: McKitStatus.GENERATING }); // releitura no CAS perdido
          transitions.casTransition.mockResolvedValue(false);
          await expect(
            service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
          ).rejects.toMatchObject({ response: { code: 'KIT_NOT_IN_REVIEW' } });
          expect(tile.discard).toHaveBeenCalledWith(manager, 'tile-1');

          // tile reaproveitado (já pertencia ao kit) NÃO é descartado na corrida perdida
          tile.discard.mockClear();
          kitRepo.findOneBy
            .mockResolvedValueOnce({ ...reviewKit, tileAssetId: 'tile-old' })
            .mockResolvedValue({ ...reviewKit, status: McKitStatus.GENERATING });
          assetRepo.findOneBy.mockResolvedValue({
            id: 'tile-old',
            metadata: { identityAssetId: 'front-1', backgroundColor: '#ABCDEF' },
          });
          await expect(
            service.approveKit('u1', 'kit-r', { voiceId: 'voice-3' }),
          ).rejects.toMatchObject({ response: { code: 'KIT_NOT_IN_REVIEW' } });
          expect(tile.discard).not.toHaveBeenCalled();
        });
      });
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

    it('kit em review sem estilo → 422 STYLE_REQUIRED (regerar É gerar referência); nada enfileirado', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        id: 'kit-r',
        userId: 'u1',
        status: McKitStatus.REVIEW,
        style: null,
      });
      await expect(service.regenerateReference('u1', 'kit-r', { slot: 2 })).rejects.toMatchObject({
        status: 422,
        response: { code: 'STYLE_REQUIRED' },
      });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('em review: enfileira {kitId, slot} com singletonKey anti-duplo-clique', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        id: 'kit-r',
        userId: 'u1',
        status: McKitStatus.REVIEW,
        style: 'cartoon_2d',
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

    it('traduzir ficha com a OpenAI: custo da chamada registrado no kit (2.6); sem crédito → UMA requisição e nenhuma linha de custo', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch');
      try {
        const keyed = {
          get: jest.fn((key: string, def?: string) =>
            key === 'OPENAI_API_KEY' ? 'sk-test' : key === 'UPLOAD_DEST' ? tmpDir : def,
          ),
        };
        const real = new McKitsService(
          dataSource as unknown as DataSource,
          transitions as unknown as TaskTransitionService,
          queue as unknown as AnimationQueueService,
          mascots as unknown as MascotsService,
          moderation as unknown as ModerationProvider,
          commercials as unknown as CommercialsService,
          voices as unknown as McVoicesService,
          keyed as unknown as ConfigService,
          clients as unknown as ClientsService,
          view as unknown as McKitViewService,
          candidates as unknown as McKitCandidatesService,
          mouthGate as unknown as McMouthGateService,
          tile as unknown as McKitTileService,
          new McStorageService(keyed as unknown as ConfigService),
        );
        const legacy = {
          ...reviewKit,
          canonicalDesc: JSON.stringify({
            traits: ['capybara character'],
            colors: [],
            style: '3D cartoon',
            doNots: ['never change the species'],
          }),
        };
        kitRepo.findOneBy.mockResolvedValue(legacy);
        const respond = (status: number, body: unknown) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        fetchSpy.mockResolvedValueOnce(
          respond(200, {
            id: 'c1',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o-mini-2024-07-18',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    traits: ['personagem capivara'],
                    accessories: [],
                    doNots: ['nunca mudar a espécie'],
                    style: 'desenho 3D',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
          }),
        );
        await real.translateSheet('u1', 'kit-r');
        expect(commercials.appendEvent).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({
            refId: 'kit-r',
            kind: 'provider_cost',
            // 200 × 0,15/1M + 100 × 0,6/1M
            detail: expect.objectContaining({ call: 'sheet_translation', costUsd: 0.00009 }),
          }),
        );
        expect(manager.increment).toHaveBeenCalledWith(
          McCharacterKit,
          { id: 'kit-r' },
          'providerCostUsd',
          0.00009,
        );

        commercials.appendEvent.mockClear();
        fetchSpy.mockClear();
        fetchSpy.mockResolvedValue(
          respond(429, {
            error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' },
          }),
        );
        await expect(real.translateSheet('u1', 'kit-r')).rejects.toMatchObject({ code: 'quota' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(commercials.appendEvent).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
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
