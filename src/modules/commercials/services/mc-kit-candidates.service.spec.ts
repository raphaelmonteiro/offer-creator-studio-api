import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MC_EVENTS_CHANNEL } from '../../../shared/events/animation-events.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { AnimationQueueService, QUEUES } from '../../../shared/queue/animation-queue.service';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { MascotsService } from '../../mascots/mascots.service';
import { CommercialsService } from '../commercials.service';
import { STYLE_BLOCKS } from '../domain/mc-kit-identity';
import { McMouthVerdict } from '../domain/mc-mouth-gate';
import { McKitStatus } from '../domain/mc-state-machines';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McKitCandidate } from '../entities/mc-kit-candidate.entity';
import {
  MC_CANDIDATES_EXPIRE_S,
  MC_IMAGE_EXPIRE_S,
  McKitCandidatesService,
  candidateCount,
  listStyleReferences,
} from './mc-kit-candidates.service';
import { McKitTileService } from './mc-kit-tile.service';
import { McKitViewService } from './mc-kit-view.service';
import { McStorageService } from './mc-storage.service';

const passed: McMouthVerdict = {
  hasMouth: true,
  mouthOpenPossible: true,
  confidence: 0.9,
  bbox: { x: 0.3, y: 0.2, w: 0.4, h: 0.4 },
  model: 'mock',
  at: '2026-10-12T00:00:00.000Z',
};
const blocked: McMouthVerdict = { ...passed, hasMouth: false, mouthOpenPossible: false };

describe('McKitCandidatesService — rodadas de candidatos, escolha e "usar como está" (D4)', () => {
  const originalCount = process.env.MC_KIT_CANDIDATE_COUNT;
  let tmpDir: string;
  let kitRepo: { findOneBy: jest.Mock };
  let candidateRepo: { findOneBy: jest.Mock; find: jest.Mock; findOne: jest.Mock };
  /** Marca o COMMIT da transação simulada: a fila só pode ser tocada depois dele (L1). */
  let committed: jest.Mock;
  let assetRepo: { save: jest.Mock; find: jest.Mock; softDelete: jest.Mock };
  let manager: { insert: jest.Mock; update: jest.Mock; softDelete: jest.Mock };
  let dataSource: { getRepository: jest.Mock; transaction: jest.Mock };
  let transitions: { casTransition: jest.Mock; notify: jest.Mock };
  let queue: { publish: jest.Mock };
  let commercials: { appendEvent: jest.Mock };
  let mascots: { findOne: jest.Mock };
  let view: {
    findOwned: jest.Mock;
    findOne: jest.Mock;
    toView: jest.Mock;
    resolveIdentityAsset: jest.Mock;
  };
  let tile: { discard: jest.Mock };
  let service: McKitCandidatesService;

  const logoKit = {
    id: 'kit-1',
    userId: 'u1',
    mascotId: 'logo-1',
    source: 'logo',
    style: '3d_render',
    identityMode: 'generated',
    identityAssetId: null,
    tileAssetId: null,
    tileBackgroundColor: '#E5E7EB',
    candidateRoundId: 'round-0',
    status: McKitStatus.CANDIDATES,
    mouthGate: { logo: passed },
    referenceAssetIds: [],
  } as unknown as McCharacterKit;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-kit-cands-'));
    await fs.mkdir(path.join(tmpDir, 'mascots'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'mascots', 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
    );
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (originalCount === undefined) delete process.env.MC_KIT_CANDIDATE_COUNT;
    else process.env.MC_KIT_CANDIDATE_COUNT = originalCount;
  });

  beforeEach(() => {
    delete process.env.MC_KIT_CANDIDATE_COUNT;
    kitRepo = { findOneBy: jest.fn().mockResolvedValue({ ...logoKit }) };
    candidateRepo = {
      findOneBy: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    committed = jest.fn();
    assetRepo = {
      save: jest.fn((obj: Record<string, unknown>) =>
        Promise.resolve({ id: 'asset-logo', ...obj }),
      ),
      find: jest.fn().mockResolvedValue([]),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    manager = {
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      softDelete: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === McCharacterKit) return kitRepo;
        if (entity === McKitCandidate) return candidateRepo;
        if (entity === AnimationAsset) return assetRepo;
        throw new Error('repo inesperado');
      }),
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
    commercials = { appendEvent: jest.fn().mockResolvedValue(undefined) };
    mascots = {
      findOne: jest.fn().mockResolvedValue({
        id: 'logo-1',
        kind: 'logo',
        cutoutUrl: '/uploads/mascots/logo.png',
        sourceImageUrl: '/uploads/mascots/logo.png',
        width: 64,
        height: 48,
        hasAlpha: true,
      }),
    };
    view = {
      findOwned: jest.fn(() => kitRepo.findOneBy({ id: 'kit-1' })),
      findOne: jest.fn(async () => ({
        ...(await kitRepo.findOneBy({ id: 'kit-1' })),
        references: [],
      })),
      toView: jest.fn(async (kit: McCharacterKit) => ({
        ...kit,
        references: [],
        useAsIsAvailable: kit.status === McKitStatus.CANDIDATES,
      })),
      resolveIdentityAsset: jest.fn().mockResolvedValue({
        id: 'front-1',
        fileUrl: '/uploads/mascots/logo.png',
      }),
    };
    tile = { discard: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: jest.fn((key: string, def?: string) => (key === 'UPLOAD_DEST' ? tmpDir : def)),
    };
    service = new McKitCandidatesService(
      dataSource as unknown as DataSource,
      transitions as unknown as TaskTransitionService,
      queue as unknown as AnimationQueueService,
      commercials as unknown as CommercialsService,
      new McStorageService(config as unknown as ConfigService),
      mascots as unknown as MascotsService,
      config as unknown as ConfigService,
      view as unknown as McKitViewService,
      tile as unknown as McKitTileService,
    );
  });

  /** O publish aconteceu DEPOIS do commit (nunca dentro da transação). */
  const expectPublishedAfterCommit = () => {
    expect(queue.publish).toHaveBeenCalled();
    expect(committed).toHaveBeenCalled();
    expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
      queue.publish.mock.invocationCallOrder[0],
    );
  };

  describe('openRound — rodada pré-inserida + job na mc.image', () => {
    it('insere 4 candidatos (default) com prompt de mascotização no estilo do kit e devolve o job {kitId, candidates, roundId} (publicado só após o commit)', async () => {
      const round = await service.openRound(manager as unknown as EntityManager, logoKit, {
        kind: 'mascotization',
      });
      expect(round.count).toBe(4);
      const rows = manager.insert.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(manager.insert.mock.calls[0][0]).toBe(McKitCandidate);
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.idx)).toEqual([0, 1, 2, 3]);
      for (const row of rows) {
        expect(row).toMatchObject({
          kitId: 'kit-1',
          roundId: round.roundId,
          kind: 'mascotization',
          assetId: null,
          chosen: false,
        });
        const prompt = row.prompt as string;
        expect(prompt).toContain(STYLE_BLOCKS['3d_render']);
        expect(prompt).toContain('derived from the logo');
        expect(prompt).toContain('#E5E7EB');
        expect(prompt).toMatch(/Variation \d of 4/);
        expect(prompt).not.toMatch(/Pixar|Disney|Dreamworks/i);
      }
      expect(manager.update).toHaveBeenCalledWith(
        McCharacterKit,
        { id: 'kit-1' },
        { candidateRoundId: round.roundId },
      );
      // openRound NÃO publica (está dentro da transação de quem chama)
      expect(queue.publish).not.toHaveBeenCalled();
      expect(round.job).toEqual({ kitId: 'kit-1', candidates: true, roundId: round.roundId });
      await service.publishRound(round.job);
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        { kitId: 'kit-1', candidates: true, roundId: round.roundId },
        {
          expireInSeconds: MC_CANDIDATES_EXPIRE_S,
          singletonKey: `kit-candidates:kit-1:${round.roundId}`,
        },
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ kind: 'candidates_round_opened', refId: 'kit-1' }),
      );
    });

    it('MC_KIT_CANDIDATE_COUNT é clampado a 4..6', () => {
      expect(candidateCount({})).toBe(4);
      expect(candidateCount({ MC_KIT_CANDIDATE_COUNT: '6' })).toBe(6);
      expect(candidateCount({ MC_KIT_CANDIDATE_COUNT: '9' })).toBe(6);
      expect(candidateCount({ MC_KIT_CANDIDATE_COUNT: '2' })).toBe(4);
      expect(candidateCount({ MC_KIT_CANDIDATE_COUNT: 'abc' })).toBe(4);
    });

    it('referências de estilo são opcionais: sem pasta configurada, só o logo vai como referência', async () => {
      expect(await listStyleReferences('3d_render', undefined)).toEqual([]);
      expect(await listStyleReferences(null, '/tmp')).toEqual([]);
      const dir = path.join(tmpDir, 'style-refs');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, '3d_render-1.png'), Buffer.from('x'));
      await fs.writeFile(path.join(dir, '3d_render-3.jpg'), Buffer.from('x'));
      expect(await listStyleReferences('3d_render', dir)).toEqual([
        path.join(dir, '3d_render-1.png'),
        path.join(dir, '3d_render-3.jpg'),
      ]);
    });
  });

  describe('startRound — nova rodada com ajustes', () => {
    it('kit fora de candidates → 422 KIT_NOT_IN_CANDIDATES, nada enfileirado', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, status: McKitStatus.GENERATING });
      await expect(service.startRound('u1', 'kit-1', 'menos infantil')).rejects.toMatchObject({
        status: 422,
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
      expect(queue.publish).not.toHaveBeenCalled();
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('candidates → generating via CAS; ajustes gravados nas linhas e no prompt; rodada anterior preservada', async () => {
      await service.startRound('u1', 'kit-1', 'menos infantil, manter o olho azul');
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.CANDIDATES,
        McKitStatus.GENERATING,
      );
      const rows = manager.insert.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(rows[0].adjustments).toBe('menos infantil, manter o olho azul');
      expect(rows[0].prompt).toContain('menos infantil, manter o olho azul');
      // nenhuma linha antiga é apagada: as rodadas anteriores ficam para comparação
      expect(manager.softDelete).not.toHaveBeenCalled();
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.GENERATING },
        MC_EVENTS_CHANNEL,
      );
      // o job da rodada sai DEPOIS do commit (L1): o consumer precisa ver as linhas
      expectPublishedAfterCommit();
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        expect.objectContaining({ kitId: 'kit-1', candidates: true }),
        expect.objectContaining({ expireInSeconds: MC_CANDIDATES_EXPIRE_S }),
      );
    });

    it('CAS perdido (kit mudou entre a leitura e a transação) → 422 e NADA publicado', async () => {
      transitions.casTransition.mockResolvedValue(false);
      await expect(service.startRound('u1', 'kit-1', 'x')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
      expect(queue.publish).not.toHaveBeenCalled();
    });
  });

  describe('choose — candidato vira identidade e as referências são geradas a partir dele', () => {
    const candidate = {
      id: 'cand-2',
      kitId: 'kit-1',
      roundId: 'round-0',
      idx: 1,
      kind: 'mascotization',
      assetId: 'asset-cand-2',
    };

    it('candidato de outro kit/inexistente → 404; ainda não gerado → 422 CANDIDATE_NOT_READY', async () => {
      candidateRepo.findOneBy.mockResolvedValue(null);
      await expect(service.choose('u1', 'kit-1', 'cand-x')).rejects.toMatchObject({ status: 404 });
      candidateRepo.findOneBy.mockResolvedValue({ ...candidate, assetId: null });
      await expect(service.choose('u1', 'kit-1', 'cand-2')).rejects.toMatchObject({
        status: 422,
        response: { code: 'CANDIDATE_NOT_READY' },
      });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('em candidates: CAS → generating com identityAssetId/generated, tile anterior descartado, job {kitId} publicado', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        tileAssetId: 'tile-old',
        mouthGate: { logo: passed, identity: { ...blocked, identityAssetId: 'old' } },
      });
      candidateRepo.findOneBy.mockResolvedValue({ ...candidate });

      await service.choose('u1', 'kit-1', 'cand-2');

      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.CANDIDATES,
        McKitStatus.GENERATING,
        {
          identityAssetId: 'asset-cand-2',
          identityMode: 'generated',
          tileAssetId: null,
          // a rodada fecha: job de rodada atrasado vira no-op (M2)
          candidateRoundId: null,
          // veredito da identidade anterior cai; o do logo fica
          mouthGate: { logo: passed },
        },
      );
      expect(manager.update).toHaveBeenCalledWith(
        McKitCandidate,
        { kitId: 'kit-1', chosen: true },
        { chosen: false },
      );
      expect(manager.update).toHaveBeenCalledWith(
        McKitCandidate,
        { id: 'cand-2' },
        { chosen: true },
      );
      expect(tile.discard).toHaveBeenCalledWith(manager, 'tile-old');
      // primeira geração: job simples, publicado DEPOIS do commit
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        { kitId: 'kit-1' },
        expect.objectContaining({ expireInSeconds: MC_IMAGE_EXPIRE_S }),
      );
      expectPublishedAfterCommit();
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.GENERATING },
        MC_EVENTS_CHANNEL,
      );
    });

    it('em review (troca de identidade / variante com boca): review → generating e o job leva fromReview + identidade anterior (M3)', async () => {
      const gate = { logo: passed, identity: { ...passed, identityAssetId: 'old-identity' } };
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        status: McKitStatus.REVIEW,
        identityAssetId: 'old-identity',
        mouthGate: gate,
      });
      candidateRepo.findOneBy.mockResolvedValue({ ...candidate, kind: 'mouth_variant' });
      await service.choose('u1', 'kit-1', 'cand-2');
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.REVIEW,
        McKitStatus.GENERATING,
        expect.objectContaining({ identityAssetId: 'asset-cand-2' }),
      );
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        {
          kitId: 'kit-1',
          fromReview: true,
          previous: { identityAssetId: 'old-identity', identityMode: 'generated', mouthGate: gate },
        },
        expect.objectContaining({ singletonKey: 'kit-refs:kit-1:cand-2' }),
      );
      expectPublishedAfterCommit();
    });

    it('kit aprovado (imutável) ou gerando → 422 KIT_NOT_IN_CANDIDATES', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, status: McKitStatus.APPROVED });
      await expect(service.choose('u1', 'kit-1', 'cand-2')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, status: McKitStatus.GENERATING });
      await expect(service.choose('u1', 'kit-1', 'cand-2')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
    });
  });

  describe('useAsIs — logo como está (só com o gate de boca aprovado no logo cru)', () => {
    it('gate reprovado/indeciso no logo cru → 422 LOGO_MOUTH_NOT_LEGIBLE; kit de mascote → KIT_NOT_LOGO', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, mouthGate: { logo: blocked } });
      await expect(service.useAsIs('u1', 'kit-1')).rejects.toMatchObject({
        status: 422,
        response: { code: 'LOGO_MOUTH_NOT_LEGIBLE' },
      });
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        mouthGate: { logo: { ...passed, confidence: 0.4 } },
      });
      await expect(service.useAsIs('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'LOGO_MOUTH_NOT_LEGIBLE' },
      });
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, source: 'mascot' });
      await expect(service.useAsIs('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_LOGO' },
      });
      expect(assetRepo.save).not.toHaveBeenCalled();
      expect(transitions.casTransition).not.toHaveBeenCalled();
    });

    it('gate aprovado em candidates: copia os pixels do logo como identidade e vai a review com logo_as_is', async () => {
      await service.useAsIs('u1', 'kit-1');

      expect(assetRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'kit_candidate',
          origin: 'imported',
          hasAlpha: true,
          fileUrl: expect.stringMatching(
            /^\/uploads\/commercials\/kits\/kit-1\/identity-logo-\d+\.png$/,
          ),
          metadata: expect.objectContaining({ role: 'logo_as_is', sourceMascotId: 'logo-1' }),
        }),
      );
      const saved = (assetRepo.save.mock.calls[0][0] as { fileUrl: string }).fileUrl;
      const copied = await fs.readFile(path.join(tmpDir, saved.replace(/^\/uploads\//, '')));
      expect(copied).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.CANDIDATES,
        McKitStatus.REVIEW,
        expect.objectContaining({
          identityMode: 'logo_as_is',
          identityAssetId: 'asset-logo',
          candidateRoundId: null,
          tileAssetId: null,
          // o veredito do logo cru É o da identidade (mesmos pixels): a
          // aprovação reaproveita e não gasta visão de novo (M1)
          mouthGate: { logo: passed, identity: { ...passed, identityAssetId: 'asset-logo' } },
        }),
        undefined, // em candidates não há condição extra
      );
      expect(queue.publish).not.toHaveBeenCalled(); // nenhuma referência é gerada
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        { kind: 'mc_kit', kitId: 'kit-1', status: McKitStatus.REVIEW },
        MC_EVENTS_CHANNEL,
      );
    });

    it('rodada ainda gerando (generating com candidateRoundId) → permitido: generating → review, a rodada em voo é abandonada (L2)', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        status: McKitStatus.GENERATING,
        candidateRoundId: 'round-0',
      });
      await service.useAsIs('u1', 'kit-1');
      expect(transitions.casTransition).toHaveBeenCalledWith(
        manager,
        McCharacterKit,
        'kit-1',
        McKitStatus.GENERATING,
        McKitStatus.REVIEW,
        expect.objectContaining({ identityMode: 'logo_as_is', candidateRoundId: null }),
        // a MESMA UPDATE exige a rodada ainda em voo: uma escolha feita nesse
        // meio-tempo (referências em voo) não é atropelada
        { sql: '"candidateRoundId" IS NOT NULL' },
      );
      expect(commercials.appendEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          fromStatus: McKitStatus.GENERATING,
          detail: expect.objectContaining({ abandonedRoundId: 'round-0' }),
        }),
      );
    });

    it('CAS perdido (kit mudou entre a leitura e a transação) → 422 e a cópia do logo é descartada', async () => {
      transitions.casTransition.mockResolvedValue(false);
      await expect(service.useAsIs('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
      expect(assetRepo.save).toHaveBeenCalledTimes(1);
      // fora da transação perdedora (o rollback não desfaz o descarte)
      expect(assetRepo.softDelete).toHaveBeenCalledWith('asset-logo');
      expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
        assetRepo.softDelete.mock.invocationCallOrder[0],
      );
      expect(commercials.appendEvent).not.toHaveBeenCalled();
      expect(tile.discard).not.toHaveBeenCalled();
    });

    it('generating SEM rodada (referências em voo após a escolha) ou já logo_as_is → 422 KIT_NOT_IN_CANDIDATES', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        status: McKitStatus.GENERATING,
        candidateRoundId: null,
        identityAssetId: 'asset-cand',
      });
      await expect(service.useAsIs('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        status: McKitStatus.REVIEW,
        identityMode: 'logo_as_is',
      });
      await expect(service.useAsIs('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_CANDIDATES' },
      });
      expect(assetRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('requestMouthVariant — variante com boca na revisão', () => {
    it('em review: abre rodada mouth_variant com 1 candidato, kit segue em review, UI avisada por evento', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, status: McKitStatus.REVIEW });
      await service.requestMouthVariant('u1', 'kit-1');
      const rows = manager.insert.mock.calls[0][1] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'mouth_variant', idx: 0 });
      expect(rows[0].prompt).toMatch(/articulable mouth/);
      expect(rows[0].prompt).toMatch(/Change NOTHING else/);
      expect(queue.publish).toHaveBeenCalledWith(
        QUEUES.MC_IMAGE,
        expect.objectContaining({ kitId: 'kit-1', candidates: true }),
        expect.anything(),
      );
      expectPublishedAfterCommit();
      expect(transitions.casTransition).not.toHaveBeenCalled();
      expect(transitions.notify).toHaveBeenCalledWith(
        manager,
        'u1',
        {
          kind: 'mc_kit',
          kitId: 'kit-1',
          status: McKitStatus.REVIEW,
          event: 'mouth_variant_requested',
        },
        MC_EVENTS_CHANNEL,
      );
    });

    it('fora de review → 422 KIT_NOT_IN_REVIEW; sem identidade → 422 KIT_IDENTITY_MISSING', async () => {
      await expect(service.requestMouthVariant('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'KIT_NOT_IN_REVIEW' },
      });
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, status: McKitStatus.REVIEW });
      view.resolveIdentityAsset.mockResolvedValue(null);
      await expect(service.requestMouthVariant('u1', 'kit-1')).rejects.toMatchObject({
        response: { code: 'KIT_IDENTITY_MISSING' },
      });
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('sem estilo → 422 STYLE_REQUIRED; variante ainda em andamento → 422 MOUTH_VARIANT_IN_PROGRESS (L3)', async () => {
      kitRepo.findOneBy.mockResolvedValue({ ...logoKit, status: McKitStatus.REVIEW, style: null });
      await expect(service.requestMouthVariant('u1', 'kit-1')).rejects.toMatchObject({
        status: 422,
        response: { code: 'STYLE_REQUIRED' },
      });

      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        status: McKitStatus.REVIEW,
        candidateRoundId: 'round-mv',
      });
      candidateRepo.findOne.mockResolvedValue({ id: 'mv-0', roundId: 'round-mv', assetId: null });
      await expect(service.requestMouthVariant('u1', 'kit-1')).rejects.toMatchObject({
        status: 422,
        response: { code: 'MOUTH_VARIANT_IN_PROGRESS', details: { roundId: 'round-mv' } },
      });
      // só a rodada CORRENTE, mouth_variant, SEM imagem e recente conta como "em andamento"
      expect(candidateRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            kitId: 'kit-1',
            roundId: 'round-mv',
            kind: 'mouth_variant',
          }),
        }),
      );
      expect(manager.insert).not.toHaveBeenCalled();
      expect(queue.publish).not.toHaveBeenCalled();
    });

    it('variante anterior que falhou (rodada fechada: candidateRoundId nulo) não bloqueia um novo pedido (L3)', async () => {
      kitRepo.findOneBy.mockResolvedValue({
        ...logoKit,
        status: McKitStatus.REVIEW,
        candidateRoundId: null,
      });
      await service.requestMouthVariant('u1', 'kit-1');
      expect(candidateRepo.findOne).not.toHaveBeenCalled();
      expect(manager.insert).toHaveBeenCalled();
      expectPublishedAfterCommit();
    });
  });

  it('list agrupa as rodadas (antigas preservadas) com URLs dos assets e o flag de "usar como está"', async () => {
    const t0 = new Date('2026-10-12T10:00:00Z');
    const t1 = new Date('2026-10-12T10:05:00Z');
    candidateRepo.find.mockResolvedValue([
      {
        id: 'c0',
        roundId: 'round-0',
        idx: 0,
        kind: 'mascotization',
        assetId: 'a0',
        chosen: false,
        prompt: 'p',
        adjustments: null,
        createdAt: t0,
      },
      {
        id: 'c1',
        roundId: 'round-0',
        idx: 1,
        kind: 'mascotization',
        assetId: 'a1',
        chosen: false,
        prompt: 'p',
        adjustments: null,
        createdAt: t0,
      },
      {
        id: 'c2',
        roundId: 'round-1',
        idx: 0,
        kind: 'mascotization',
        assetId: null,
        chosen: false,
        prompt: 'p2',
        adjustments: 'menos infantil',
        createdAt: t1,
      },
    ]);
    assetRepo.find.mockResolvedValue([
      { id: 'a0', fileUrl: '/uploads/a0.png' },
      { id: 'a1', fileUrl: '/uploads/a1.png' },
    ]);
    const list = await service.list('u1', 'kit-1');
    expect(list).toMatchObject({
      kitId: 'kit-1',
      currentRoundId: 'round-0',
      useAsIsAvailable: true,
    });
    expect(list.rounds.map((r) => r.roundId)).toEqual(['round-0', 'round-1']);
    expect(list.rounds[0].candidates.map((c) => c.url)).toEqual([
      '/uploads/a0.png',
      '/uploads/a1.png',
    ]);
    expect(list.rounds[1]).toMatchObject({ adjustments: 'menos infantil' });
    expect(list.rounds[1].candidates[0]).toMatchObject({ assetId: null, url: null });
  });

  it('translateAdjustments em modo mock devolve o texto como está (sem gastar chamada)', async () => {
    await expect(service.translateAdjustments('menos infantil')).resolves.toBe('menos infantil');
  });
});
