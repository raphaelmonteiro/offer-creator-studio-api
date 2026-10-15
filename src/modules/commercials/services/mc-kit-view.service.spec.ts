import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { Mascot } from '../../mascots/entities/mascot.entity';
import { McMouthVerdict } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McEvent } from '../entities/mc-event.entity';
import { kitLabel, kitUseAsIsAvailable, McKitViewService } from './mc-kit-view.service';

const passed: McMouthVerdict = {
  hasMouth: true,
  mouthOpenPossible: true,
  confidence: 0.9,
  bbox: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
  model: 'mock',
  at: '2026-10-12T00:00:00.000Z',
};
const blocked: McMouthVerdict = { ...passed, hasMouth: false, mouthOpenPossible: false };
const undecided: McMouthVerdict = { ...passed, confidence: 0.4 };

describe('McKitViewService — view do kit para a API (D1/D4)', () => {
  let kitRepo: { findOneBy: jest.Mock };
  let assetRepo: { find: jest.Mock; findOneBy: jest.Mock };
  let mascotRepo: { find: jest.Mock };
  let eventRepo: { find: jest.Mock };
  let service: McKitViewService;

  const baseKit = {
    id: 'kit-12345678-abcd',
    userId: 'u1',
    mascotId: 'logo-1',
    source: 'logo',
    style: '3d_render',
    identityMode: 'generated',
    identityAssetId: null,
    tileAssetId: null,
    candidateRoundId: 'round-1',
    referenceAssetIds: [],
    status: McKitStatus.CANDIDATES,
    mouthGate: { logo: passed },
  } as unknown as McCharacterKit;

  beforeEach(() => {
    kitRepo = { findOneBy: jest.fn().mockResolvedValue({ ...baseKit }) };
    assetRepo = { find: jest.fn().mockResolvedValue([]), findOneBy: jest.fn() };
    mascotRepo = {
      find: jest.fn().mockResolvedValue([{ id: 'logo-1', name: 'Logo Mercado Bom' }]),
    };
    eventRepo = { find: jest.fn().mockResolvedValue([]) };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === McCharacterKit) return kitRepo;
        if (entity === AnimationAsset) return assetRepo;
        if (entity === Mascot) return mascotRepo;
        if (entity === McEvent) return eventRepo;
        throw new Error('repo inesperado');
      }),
    } as unknown as DataSource;
    service = new McKitViewService(dataSource);
  });

  describe('useAsIsAvailable — "usar o logo como está"', () => {
    it('logo com gate aprovado em candidates OU em generating com rodada em voo → true', () => {
      expect(kitUseAsIsAvailable(baseKit)).toBe(true);
      expect(
        kitUseAsIsAvailable({
          ...baseKit,
          status: McKitStatus.GENERATING,
          candidateRoundId: 'round-1',
        }),
      ).toBe(true);
    });

    it('gate reprovado, indeciso ou ausente → false', () => {
      expect(kitUseAsIsAvailable({ ...baseKit, mouthGate: { logo: blocked } })).toBe(false);
      expect(kitUseAsIsAvailable({ ...baseKit, mouthGate: { logo: undecided } })).toBe(false);
      expect(kitUseAsIsAvailable({ ...baseKit, mouthGate: null })).toBe(false);
    });

    it('kit de mascote → false; logo já usado como está → false', () => {
      expect(kitUseAsIsAvailable({ ...baseKit, source: 'mascot' })).toBe(false);
      expect(
        kitUseAsIsAvailable({
          ...baseKit,
          identityMode: 'logo_as_is',
          status: McKitStatus.REVIEW,
        }),
      ).toBe(false);
    });

    it('generating SEM rodada (referências em voo após a escolha) e review/approved → false', () => {
      expect(
        kitUseAsIsAvailable({ ...baseKit, status: McKitStatus.GENERATING, candidateRoundId: null }),
      ).toBe(false);
      expect(kitUseAsIsAvailable({ ...baseKit, status: McKitStatus.REVIEW })).toBe(false);
      expect(kitUseAsIsAvailable({ ...baseKit, status: McKitStatus.APPROVED })).toBe(false);
    });
  });

  it('mouthGateStatus decide logo e identidade separadamente; null quando não rodou', async () => {
    const view = await service.toView({
      ...baseKit,
      mouthGate: { logo: passed, identity: { ...blocked, identityAssetId: 'a' } },
    });
    expect(view.mouthGateStatus).toEqual({ logo: 'passed', identity: 'blocked' });
    expect((await service.toView({ ...baseKit, mouthGate: null })).mouthGateStatus).toEqual({
      logo: null,
      identity: null,
    });
    expect(
      (await service.toView({ ...baseKit, mouthGate: { logo: undecided } })).mouthGateStatus.logo,
    ).toBe('undecided');
  });

  describe('resolveIdentityAsset', () => {
    it('identityAssetId definido → o próprio asset', async () => {
      assetRepo.findOneBy.mockResolvedValue({ id: 'cand-asset' });
      const asset = await service.resolveIdentityAsset({
        ...baseKit,
        identityAssetId: 'cand-asset',
      });
      expect(asset).toEqual({ id: 'cand-asset' });
      expect(assetRepo.findOneBy).toHaveBeenCalledWith({ id: 'cand-asset' });
      expect(assetRepo.find).not.toHaveBeenCalled();
    });

    it('sem identityAssetId cai para a referência frontal (slot 2); sem referências → null', async () => {
      assetRepo.find.mockResolvedValue([
        { id: 'r0', metadata: { slot: 0 } },
        { id: 'r2', metadata: { slot: 2 } },
      ]);
      const asset = await service.resolveIdentityAsset({
        ...baseKit,
        source: 'mascot',
        referenceAssetIds: ['r0', 'r2'],
      });
      expect(asset?.id).toBe('r2');
      expect(await service.resolveIdentityAsset({ ...baseKit, referenceAssetIds: [] })).toBeNull();
      assetRepo.find.mockResolvedValue([{ id: 'r0', metadata: { slot: 0 } }]);
      expect(
        await service.resolveIdentityAsset({ ...baseKit, referenceAssetIds: ['r0'] }),
      ).toBeNull();
    });
  });

  it('mascotName vem de mascots.name e label o reaproveita; cadastro ausente → "Kit <id curto>"', async () => {
    const view = await service.toView(baseKit);
    expect(view.mascotName).toBe('Logo Mercado Bom');
    expect(view.label).toBe('Logo Mercado Bom');
    expect(mascotRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ select: ['id', 'name'] }),
    );

    mascotRepo.find.mockResolvedValue([]);
    const orphan = await service.toView(baseKit);
    expect(orphan.mascotName).toBeNull();
    expect(orphan.label).toBe('Kit kit-1234');
    expect(kitLabel({ id: 'abcdefgh-x' }, '   ')).toBe('Kit abcdefgh');
  });

  it('tile expõe faceFraction e faceBelowMinimum lidos do metadata do asset', async () => {
    assetRepo.find.mockResolvedValue([
      { id: 'tile-1', fileUrl: '/uploads/tile.png', metadata: { faceFraction: 0.52 } },
    ]);
    const low = await service.toView({ ...baseKit, tileAssetId: 'tile-1' });
    expect(low.tile).toEqual({
      assetId: 'tile-1',
      url: '/uploads/tile.png',
      faceFraction: 0.52,
      faceBelowMinimum: true,
    });

    assetRepo.find.mockResolvedValue([
      { id: 'tile-1', fileUrl: '/uploads/tile.png', metadata: { faceFraction: 0.61 } },
    ]);
    expect(
      (await service.toView({ ...baseKit, tileAssetId: 'tile-1' })).tile?.faceBelowMinimum,
    ).toBe(false);

    // logo como está: sem caixa → faceFraction null e nunca "abaixo do mínimo"
    assetRepo.find.mockResolvedValue([
      { id: 'tile-1', fileUrl: '/uploads/tile.png', metadata: { faceFraction: null } },
    ]);
    expect((await service.toView({ ...baseKit, tileAssetId: 'tile-1' })).tile).toMatchObject({
      faceFraction: null,
      faceBelowMinimum: false,
    });
    expect((await service.toView(baseKit)).tile).toBeNull();
  });

  it('references ordenadas por slot, identity = identityAssetId ou a frontal; toViewMany faz UMA consulta de cada', async () => {
    assetRepo.find.mockResolvedValue([
      { id: 'r2', fileUrl: '/r2.png', metadata: { slot: 2 }, createdAt: new Date() },
      { id: 'r0', fileUrl: '/r0.png', metadata: { slot: 0 }, createdAt: new Date() },
      { id: 'cand', fileUrl: '/cand.png', metadata: {}, createdAt: new Date() },
    ]);
    mascotRepo.find.mockResolvedValue([
      { id: 'logo-1', name: 'Logo Mercado Bom' },
      { id: 'mascot-1', name: 'Capivara' },
    ]);
    const [a, b] = await service.toViewMany([
      { ...baseKit, referenceAssetIds: ['r0', 'r2'], identityAssetId: 'cand' },
      {
        ...baseKit,
        id: 'kit-2',
        mascotId: 'mascot-1',
        source: 'mascot',
        referenceAssetIds: ['r0', 'r2'],
      },
    ]);
    expect(a.references.map((r) => r.slot)).toEqual([0, 2]);
    expect(a.identity).toEqual({ assetId: 'cand', url: '/cand.png' });
    expect(b.identity).toEqual({ assetId: 'r2', url: '/r2.png' });
    expect(b.label).toBe('Capivara');
    expect(assetRepo.find).toHaveBeenCalledTimes(1);
    expect(mascotRepo.find).toHaveBeenCalledTimes(1);
    expect(await service.toViewMany([])).toEqual([]);
  });

  it('findOwned: 404 sem kit, 403 de outro usuário; findOne devolve a view', async () => {
    kitRepo.findOneBy.mockResolvedValue(null);
    await expect(service.findOwned('u1', 'x')).rejects.toBeInstanceOf(NotFoundException);
    kitRepo.findOneBy.mockResolvedValue({ ...baseKit, userId: 'u2' });
    await expect(service.findOwned('u1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    kitRepo.findOneBy.mockResolvedValue({ ...baseKit });
    const view = await service.findOne('u1', baseKit.id);
    expect(view.useAsIsAvailable).toBe(true);
    expect(view.label).toBe('Logo Mercado Bom');
    expect(view.providerCosts).toEqual([]);
  });

  describe('custo do kit (tarefa 2.6)', () => {
    it('providerCostUsd sai como número na view (texto cru do pg também); ausente = 0', async () => {
      const kit = { ...baseKit, providerCostUsd: '0.146200' } as unknown as McCharacterKit;
      expect((await service.toView(kit)).providerCostUsd).toBe(0.1462);
      expect((await service.toView(baseKit)).providerCostUsd).toBe(0);
      // a lista não carrega as linhas por chamada (só o GET do kit)
      const [listed] = await service.toViewMany([kit]);
      expect(listed.providerCosts).toBeUndefined();
      expect(eventRepo.find).not.toHaveBeenCalled();
    });

    it('GET do kit: uma linha por chamada paga (eventos provider_cost do kit, em ordem)', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...baseKit, providerCostUsd: '0.009000' });
      const at = new Date('2026-10-15T12:00:00Z');
      eventRepo.find.mockResolvedValue([
        {
          id: '1',
          createdAt: at,
          detail: {
            call: 'canonical_desc',
            provider: 'openai',
            model: 'gpt-4o-2024-08-06',
            costUsd: 0.009,
            usage: { inputTokens: 1200, outputTokens: 600, images: 0 },
            desc: { traits: ['t'] },
          },
        },
        {
          id: '2',
          createdAt: at,
          detail: {
            call: 'reference',
            provider: 'gemini',
            model: 'unknown-model',
            costUsd: null,
            usage: null,
            assetId: 'ref-1',
          },
        },
        {
          id: '3',
          createdAt: at,
          detail: {
            call: 'reference',
            provider: 'gemini',
            model: 'nano-banana-pro-preview',
            costUsd: 0.134,
            usage: { inputTokens: 0, outputTokens: 0, images: 1 },
            assetId: null,
            failure: 'timed_out',
            estimated: true,
          },
        },
      ]);
      const view = await service.findOne('u1', baseKit.id);
      expect(eventRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { refKind: 'kit', refId: baseKit.id, kind: 'provider_cost' },
          order: { id: 'ASC' },
        }),
      );
      expect(view.providerCostUsd).toBe(0.009);
      expect(view.providerCosts).toEqual([
        {
          call: 'canonical_desc',
          provider: 'openai',
          model: 'gpt-4o-2024-08-06',
          costUsd: 0.009,
          usage: { inputTokens: 1200, outputTokens: 600, images: 0 },
          assetId: null,
          failure: null,
          estimated: false,
          at,
        },
        {
          call: 'reference',
          provider: 'gemini',
          model: 'unknown-model',
          costUsd: null,
          usage: null,
          assetId: 'ref-1',
          failure: null,
          estimated: false,
          at,
        },
        {
          call: 'reference',
          provider: 'gemini',
          model: 'nano-banana-pro-preview',
          costUsd: 0.134,
          usage: { inputTokens: 0, outputTokens: 0, images: 1 },
          assetId: null,
          failure: 'timed_out',
          estimated: true,
          at,
        },
      ]);
    });
  });
});
