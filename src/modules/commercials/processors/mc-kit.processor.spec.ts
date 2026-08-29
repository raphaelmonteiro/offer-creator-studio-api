import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { GeminiImageProvider } from '../../../shared/providers/gemini-image.provider';
import { TerminalProviderError } from '../../../shared/providers/provider-errors';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitProcessor } from './mc-kit.processor';

describe('McKitProcessor — geração do kit na fila mc.image (plano §4)', () => {
  const originalProvider = process.env.MC_KIT_PROVIDER;
  let tmpDir: string;

  const baseKit = {
    id: 'kit-1',
    userId: 'u1',
    mascotId: 'mascot-1',
    status: McKitStatus.GENERATING,
    canonicalDesc: null as string | null,
    referenceAssetIds: [] as string[],
  };

  let assetSeq: number;
  let kitRepo: { findOneBy: jest.Mock };
  let assetRepo: { save: jest.Mock };
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    update: jest.Mock;
    softDelete: jest.Mock;
  };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let gemini: { generateImage: jest.Mock };
  let mascots: { findOne: jest.Mock };
  let config: { get: jest.Mock };
  let processor: McKitProcessor;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-kit-proc-'));
    await fs.mkdir(path.join(tmpDir, 'mascots'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'mascots', 'cutout.png'), Buffer.from('png-bytes'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete process.env.MC_KIT_PROVIDER; // default = mock
    assetSeq = 0;
    kitRepo = { findOneBy: jest.fn().mockResolvedValue({ ...baseKit }) };
    assetRepo = {
      save: jest.fn((obj: Record<string, unknown>) =>
        Promise.resolve({ id: `asset-${++assetSeq}`, ...obj }),
      ),
    };
    manager = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) =>
        entity === McCharacterKit ? kitRepo : assetRepo,
      ),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
    };
    transitions = {
      casTransition: jest.fn().mockResolvedValue(true),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    gemini = { generateImage: jest.fn() };
    mascots = {
      findOne: jest.fn().mockResolvedValue({
        id: 'mascot-1',
        cutoutUrl: '/uploads/mascots/cutout.png',
        sourceImageUrl: '/uploads/mascots/cutout.png',
      }),
    };
    config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    processor = new McKitProcessor(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      commercials as unknown as CommercialsService,
      gemini as unknown as GeminiImageProvider,
      mascots as unknown as MascotsService,
      config as unknown as ConfigService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_KIT_PROVIDER;
    else process.env.MC_KIT_PROVIDER = originalProvider;
  });

  it('provider mock: 4 referências sintéticas, kit → review com canonicalDesc + assets, notify em mc_events', async () => {
    await processor.process({ kitId: 'kit-1' });

    // 4 media assets kind kit_reference, um por slot
    expect(assetRepo.save).toHaveBeenCalledTimes(4);
    const slots = assetRepo.save.mock.calls.map(
      (c) => (c[0] as { metadata: { slot: number } }).metadata.slot,
    );
    expect(slots).toEqual([0, 1, 2, 3]);
    for (const [arg] of assetRepo.save.mock.calls) {
      expect(arg).toMatchObject({ kind: 'kit_reference', status: 'ready', userId: 'u1' });
      expect((arg as { fileUrl: string }).fileUrl).toMatch(
        /^\/uploads\/commercials\/kits\/kit-1\/ref-\d-\d+\.png$/,
      );
    }

    // CAS generating → review com a descrição canônica JSON e os 4 assets
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.REVIEW,
      expect.objectContaining({
        referenceAssetIds: ['asset-1', 'asset-2', 'asset-3', 'asset-4'],
        canonicalDesc: expect.any(String),
      }),
    );
    const patch = transitions.casTransition.mock.calls[0][5] as { canonicalDesc: string };
    const desc = JSON.parse(patch.canonicalDesc) as Record<string, unknown>;
    expect(desc).toMatchObject({
      traits: expect.any(Array),
      colors: expect.any(Array),
      style: expect.any(String),
      doNots: expect.any(Array),
    });

    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.REVIEW },
      MC_EVENTS_CHANNEL,
    );
    expect(gemini.generateImage).not.toHaveBeenCalled(); // mock não gasta API
  });

  it('gemini: falha de UMA imagem não derruba o kit — segue para review com 3 referências', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    jest
      .spyOn(
        processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
        'generateCanonicalDesc',
      )
      .mockResolvedValue({ traits: ['t'], colors: ['#fff'], style: 's', doNots: [] });
    gemini.generateImage
      .mockResolvedValueOnce(Buffer.from('img-0'))
      .mockRejectedValueOnce(new TerminalProviderError('bloqueada', 'content_policy'))
      .mockResolvedValueOnce(Buffer.from('img-2'))
      .mockResolvedValueOnce(Buffer.from('img-3'));

    await processor.process({ kitId: 'kit-1' });

    expect(assetRepo.save).toHaveBeenCalledTimes(3);
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.REVIEW,
      expect.objectContaining({ referenceAssetIds: ['asset-1', 'asset-2', 'asset-3'] }),
    );
    // a falha do slot 1 ficou auditada em mc_events
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        refKind: 'kit',
        kind: 'reference_failed',
        detail: expect.objectContaining({ slot: 1 }),
      }),
    );
  });

  it('menos de 2 referências geradas → kit failed (sem estorno: kit não reserva créditos na v0)', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini';
    jest
      .spyOn(
        processor as unknown as { generateCanonicalDesc: () => Promise<unknown> },
        'generateCanonicalDesc',
      )
      .mockResolvedValue({ traits: ['t'], colors: [], style: 's', doNots: [] });
    gemini.generateImage
      .mockResolvedValueOnce(Buffer.from('img-0'))
      .mockRejectedValue(new TerminalProviderError('bloqueada', 'content_policy'));

    await processor.process({ kitId: 'kit-1' });

    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.FAILED,
    );
    expect(commercials.appendEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        kind: 'transition',
        toStatus: McKitStatus.FAILED,
        detail: expect.objectContaining({ errorCode: 'kit_generation_failed' }),
      }),
    );
    expect(transitions.notify).toHaveBeenCalledWith(
      manager,
      'u1',
      { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.FAILED },
      MC_EVENTS_CHANNEL,
    );
  });

  it('descrição canônica falhou → kit failed antes de gastar com imagens', async () => {
    process.env.MC_KIT_PROVIDER = 'gemini'; // sem OPENAI_API_KEY no ConfigService fake → falha
    await processor.process({ kitId: 'kit-1' });

    expect(gemini.generateImage).not.toHaveBeenCalled();
    expect(assetRepo.save).not.toHaveBeenCalled();
    expect(transitions.casTransition).toHaveBeenCalledWith(
      manager,
      McCharacterKit,
      'kit-1',
      McKitStatus.GENERATING,
      McKitStatus.FAILED,
    );
  });

  it('job re-entrando com kit fora de generating é no-op (idempotência CAS)', async () => {
    kitRepo.findOneBy.mockResolvedValue({ ...baseKit, status: McKitStatus.REVIEW });
    await processor.process({ kitId: 'kit-1' });
    expect(mascots.findOne).not.toHaveBeenCalled();
    expect(transitions.casTransition).not.toHaveBeenCalled();
    expect(assetRepo.save).not.toHaveBeenCalled();
  });

  describe('regeneração de 1 célula ({kitId, slot})', () => {
    const reviewKit = {
      ...baseKit,
      status: McKitStatus.REVIEW,
      canonicalDesc: JSON.stringify({ traits: ['t'], colors: [], style: 's', doNots: [] }),
      referenceAssetIds: ['a1', 'a2', 'a3', 'a4'],
    };

    it('troca só o asset do slot: novo entra, antigo sai do array e é soft-deletado', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      manager.findOne.mockResolvedValue({ ...reviewKit });
      manager.find.mockResolvedValue([
        { id: 'a1', metadata: { slot: 0 } },
        { id: 'a2', metadata: { slot: 1 } },
        { id: 'a3', metadata: { slot: 2 } },
        { id: 'a4', metadata: { slot: 3 } },
      ]);

      await processor.process({ kitId: 'kit-1', slot: 2 });

      expect(assetRepo.save).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        McCharacterKit,
        { id: 'kit-1' },
        { referenceAssetIds: ['a1', 'a2', 'a4', 'asset-1'] },
      );
      expect(manager.softDelete).toHaveBeenCalledWith(AnimationAsset, 'a3');
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          kind: 'reference_regenerated',
          detail: expect.objectContaining({ slot: 2, assetId: 'asset-1' }),
        }),
      );
      // kit permanece em review — nenhuma transição de status
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('kit fora de review → regeneração é no-op', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit, status: McKitStatus.APPROVED });
      await processor.process({ kitId: 'kit-1', slot: 1 });
      expect(assetRepo.save).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('slot inválido → no-op', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...reviewKit });
      await processor.process({ kitId: 'kit-1', slot: 7 });
      expect(assetRepo.save).not.toHaveBeenCalled();
    });
  });
});
