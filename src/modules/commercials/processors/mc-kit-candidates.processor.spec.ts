import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as sharp from 'sharp';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McMouthVerdict } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitCandidate } from '../entities/mc-kit-candidate.entity';
import { McKitViewService } from '../services/mc-kit-view.service';
import { McStorageService } from '../services/mc-storage.service';
import { McKitCandidatesProcessor } from './mc-kit-candidates.processor';

const passed: McMouthVerdict = {
  hasMouth: true,
  mouthOpenPossible: true,
  confidence: 0.9,
  bbox: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
  model: 'mock',
  at: '2026-10-12T00:00:00.000Z',
};

describe('McKitCandidatesProcessor — rodada de candidatos na fila mc.image (D4)', () => {
  const originalProvider = process.env.MC_KIT_PROVIDER;
  let tmpDir: string;
  let assetSeq: number;
  let kitRepo: { findOneBy: jest.Mock };
  let candidateRepo: { find: jest.Mock; update: jest.Mock; findOne: jest.Mock };
  let assetRepo: { save: jest.Mock };
  let manager: { insert: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let gemini: { generateImageWithModel: jest.Mock };
  let mascots: { findOne: jest.Mock };
  let view: { resolveIdentityAsset: jest.Mock };
  let processor: McKitCandidatesProcessor;

  const kit = {
    id: 'kit-1',
    userId: 'u1',
    mascotId: 'logo-1',
    source: 'logo',
    style: '3d_render',
    identityMode: 'generated',
    identityAssetId: null,
    tileBackgroundColor: '#E5E7EB',
    candidateRoundId: 'round-1',
    status: McKitStatus.GENERATING,
    mouthGate: null,
  } as unknown as McCharacterKit;

  const rows = (count: number, kind = 'mascotization', roundId = 'round-1') =>
    Array.from({ length: count }, (_, idx) => ({
      id: `cand-${idx}`,
      kitId: 'kit-1',
      roundId,
      idx,
      kind,
      assetId: null as string | null,
      prompt: `prompt ${idx}`,
    }));

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-kit-cands-proc-'));
    await fs.mkdir(path.join(tmpDir, 'mascots'), { recursive: true });
    const png = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(tmpDir, 'mascots', 'logo.png'), png);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.MC_KIT_PROVIDER;
    assetSeq = 0;
    kitRepo = { findOneBy: jest.fn().mockResolvedValue({ ...kit }) };
    candidateRepo = {
      find: jest.fn().mockResolvedValue(rows(4)),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
    };
    assetRepo = {
      save: jest.fn((obj: Record<string, unknown>) =>
        Promise.resolve({ id: `asset-${++assetSeq}`, ...obj }),
      ),
    };
    manager = { insert: jest.fn() };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === McCharacterKit) return kitRepo;
        if (entity === McKitCandidate) return candidateRepo;
        if (entity === AnimationAsset) return assetRepo;
        throw new Error('repo inesperado');
      }),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    gemini = { generateImageWithModel: jest.fn() };
    mascots = {
      findOne: jest.fn().mockResolvedValue({
        id: 'logo-1',
        cutoutUrl: '/uploads/mascots/logo.png',
        sourceImageUrl: '/uploads/mascots/logo.png',
      }),
    };
    view = { resolveIdentityAsset: jest.fn().mockResolvedValue(null) };
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    } as unknown as ConfigService;
    processor = new McKitCandidatesProcessor(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      gemini as unknown as GeminiImageProvider,
      mascots as unknown as MascotsService,
      new McStorageService(config),
      view as unknown as McKitViewService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_KIT_PROVIDER;
    else process.env.MC_KIT_PROVIDER = originalProvider;
  });

  it('provider mock: 4 candidatos sintéticos gravados, linhas preenchidas, kit generating → candidates', async () => {
    await processor.process({ kitId: 'kit-1', roundId: 'round-1' });

    expect(assetRepo.save).toHaveBeenCalledTimes(4);
    for (const [arg] of assetRepo.save.mock.calls) {
      expect(arg).toMatchObject({
        kind: 'kit_candidate',
        status: 'ready',
        userId: 'u1',
        origin: 'ai_generated',
        metadata: expect.objectContaining({ roundId: 'round-1', candidateKind: 'mascotization' }),
      });
      const url = (arg as { fileUrl: string }).fileUrl;
      expect(url).toMatch(/^\/uploads\/commercials\/kits\/kit-1\/candidate-round-1-\d-\d+\.png$/);
      const meta = await sharp(
        await fs.readFile(path.join(tmpDir, url.replace(/^\/uploads\//, ''))),
      ).metadata();
      expect(meta.width).toBe(768); // 3:4, fundo liso — serve ao tile de ponta a ponta
    }
    expect(candidateRepo.update).toHaveBeenCalledTimes(4);
    expect(candidateRepo.update).toHaveBeenCalledWith({ id: 'cand-0' }, { assetId: 'asset-1' });
    expect(candidateRepo.update).toHaveBeenCalledWith({ id: 'cand-3' }, { assetId: 'asset-4' });

    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.CANDIDATES,
      { candidateRoundId: 'round-1' },
    );
    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.CANDIDATES, event: 'candidates_ready' },
      MC_EVENTS_CHANNEL,
    );
    expect(gemini.generateImageWithModel).not.toHaveBeenCalled();
  });

  it('gemini: edit com o logo como primeira referência; falha de UM candidato registra evento e a rodada segue', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    gemini.generateImageWithModel
      .mockResolvedValueOnce({ image: Buffer.from('img-0'), model: 'nano-banana-pro-preview' })
      .mockRejectedValueOnce(new TerminalProviderError('bloqueada', 'content_policy'))
      .mockResolvedValueOnce({ image: Buffer.from('img-2'), model: 'nano-banana-pro-preview' })
      .mockResolvedValueOnce({ image: Buffer.from('img-3'), model: 'nano-banana-pro-preview' });

    await processor.process({ kitId: 'kit-1', roundId: 'round-1' });

    const [firstCall] = gemini.generateImageWithModel.mock.calls[0] as [
      { prompt: string; referenceImages: Buffer[]; aspectRatio: string },
    ];
    expect(firstCall.prompt).toBe('prompt 0');
    expect(firstCall.referenceImages).toHaveLength(1); // só o logo (sem MC_KIT_STYLE_REFS_DIR)
    expect(firstCall.aspectRatio).toBe('3:4');
    expect(assetRepo.save).toHaveBeenCalledTimes(3);
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        kind: 'candidate_failed',
        detail: expect.objectContaining({ roundId: 'round-1', idx: 1 }),
      }),
    );
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.CANDIDATES,
      { candidateRoundId: 'round-1' },
    );
  });

  describe('rodada sem nenhum candidato', () => {
    beforeEach(() => {
      process.env.MC_KIT_PROVIDER = 'gemini';
      gemini.generateImageWithModel.mockRejectedValue(
        new TerminalProviderError('bloqueada', 'content_policy'),
      );
    });

    it('primeira rodada, sem "usar como está" → kit failed', async () => {
      await processor.process({ kitId: 'kit-1', roundId: 'round-1' });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.FAILED,
        {},
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'transition',
          toStatus: McKitStatus.FAILED,
          detail: expect.objectContaining({ errorCode: 'candidates_generation_failed' }),
        }),
      );
    });

    it('com rodada anterior pronta → volta a candidates apontando para ela (rodadas preservadas)', async () => {
      candidateRepo.findOne.mockResolvedValue({ id: 'old', roundId: 'round-0', assetId: 'a' });
      await processor.process({ kitId: 'kit-1', roundId: 'round-1' });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.CANDIDATES,
        { candidateRoundId: 'round-0' },
      );
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        expect.objectContaining({
          status: McKitStatus.CANDIDATES,
          event: 'candidates_round_failed',
        }),
        MC_EVENTS_CHANNEL,
      );
    });

    it('sem rodada anterior mas com gate do logo aprovado → candidates vazio ("usar como está" segue possível)', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...kit, mouthGate: { logo: passed } });
      await processor.process({ kitId: 'kit-1', roundId: 'round-1' });
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.CANDIDATES,
        { candidateRoundId: null },
      );
    });
  });

  it('rodada mouth_variant: usa a identidade atual como referência, kit fica em review e a UI é avisada', async () => {
    kitRepo.findOneBy.mockResolvedValue({
      ...kit,
      status: McKitStatus.REVIEW,
      identityAssetId: 'asset-identity',
    });
    candidateRepo.find.mockResolvedValue(rows(1, 'mouth_variant', 'round-mv'));
    view.resolveIdentityAsset.mockResolvedValue({
      id: 'asset-identity',
      fileUrl: '/uploads/mascots/logo.png',
    });

    await processor.process({ kitId: 'kit-1', roundId: 'round-mv' });

    expect(view.resolveIdentityAsset).toHaveBeenCalled();
    expect(assetRepo.save).toHaveBeenCalledTimes(1);
    expect(assetRepo.save.mock.calls[0][0]).toMatchObject({
      kind: 'kit_candidate',
      metadata: expect.objectContaining({ candidateKind: 'mouth_variant' }),
    });
    expect(transitions.casTransition).not.toHaveBeenCalled();
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        kind: 'mouth_variant_ready',
        detail: { roundId: 'round-mv', ready: 1 },
      }),
    );
    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.REVIEW, event: 'mouth_variant_ready' },
      MC_EVENTS_CHANNEL,
    );
  });

  it('kit fora do estado esperado (job duplicado/expirado) é no-op; linhas já geradas não são refeitas', async () => {
    kitRepo.findOneBy.mockResolvedValue({ ...kit, status: McKitStatus.CANDIDATES });
    await processor.process({ kitId: 'kit-1', roundId: 'round-1' });
    expect(assetRepo.save).not.toHaveBeenCalled();
    expect(transitions.casTransition).not.toHaveBeenCalled();

    kitRepo.findOneBy.mockResolvedValue({ ...kit });
    const partial = rows(4);
    partial[0].assetId = 'already';
    partial[1].assetId = 'already-2';
    candidateRepo.find.mockResolvedValue(partial);
    await processor.process({ kitId: 'kit-1', roundId: 'round-1' });
    expect(assetRepo.save).toHaveBeenCalledTimes(2);
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.CANDIDATES,
      { candidateRoundId: 'round-1' },
    );
  });

  it('logo sem imagem no disco → rodada falha sem gastar imagem', async () => {
    mascots.findOne.mockResolvedValue({ id: 'logo-1', cutoutUrl: '/uploads/mascots/sumiu.png' });
    await processor.process({ kitId: 'kit-1', roundId: 'round-1' });
    expect(assetRepo.save).not.toHaveBeenCalled();
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.FAILED,
      {},
    );
  });
});
