import { DataSource, EntityManager } from 'typeorm';
import { CreditsService } from '../../../shared/credits/credits.service';
import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { TaskTransitionService } from '../../../shared/state/task-transition.service';
import { CommercialsService } from '../commercials.service';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McStepStatus } from '../domain/mc-state-machines';
import { McScript, McStepType } from '../domain/mc-types';
import { McCharacterKit } from '../entities/mc-character-kit.entity';
import { McProject } from '../entities/mc-project.entity';
import { McStep } from '../entities/mc-step.entity';
import { McScriptProcessor } from './mc-script.processor';

/** O step `script` congela modo sem fundo, enquadramento e cor-chave (video-mascote-transparente, D9). */
describe('McScriptProcessor — roteiro com personagem sem fundo (F1 e peça)', () => {
  const originalProvider = process.env.MC_SCRIPT_PROVIDER;
  const step = {
    id: 'st',
    projectId: 'p1',
    type: McStepType.SCRIPT,
    status: McStepStatus.QUEUED,
    attempts: 0,
  };
  let project: Record<string, unknown>;
  let kit: Record<string, unknown>;
  let manager: { update: jest.Mock; insert: jest.Mock };
  let processor: McScriptProcessor;

  const products = [
    { id: 'o1', name: 'Arroz 5kg', price: '24,90' },
    { id: 'o2', name: 'Feijão 1kg', price: '7,49' },
  ];

  beforeEach(() => {
    process.env.MC_SCRIPT_PROVIDER = 'mock';
    kit = {
      id: 'k1',
      identityMode: 'generated',
      tileAssetId: 'tile-1',
      bodyTileAssetId: 'body-1',
    };
    project = {
      id: 'p1',
      userId: 'u1',
      kitId: 'k1',
      format: 'talking_art',
      pipelineVersion: MC_PIPELINE_V2,
      tier: 'economico',
      aspectRatio: '9:16',
      briefing: 'Ofertas',
      targetDurationS: 20,
      backgroundArtAssetId: 'art-1',
      reservedCredits: 0,
      consumedCredits: 0,
      logoBox: null,
      options: { musicEnabled: false, captionsEnabled: false, products },
    };
    manager = { update: jest.fn().mockResolvedValue(undefined), insert: jest.fn() };
    const assets: Record<string, Record<string, unknown>> = {
      'tile-1': { id: 'tile-1', width: 720, height: 960 },
      'body-1': {
        id: 'body-1',
        width: 720,
        height: 1440,
        metadata: { cutoutKey: { chosen: '#0047BB', safe: true, candidates: [] } },
      },
      'art-1': { id: 'art-1', width: 1080, height: 1920 },
    };
    const dataSource = {
      getRepository: jest.fn((entity: unknown) => ({
        findOneBy: jest.fn((where: { id: string }) => {
          if (entity === McStep) return Promise.resolve(step);
          if (entity === McProject) return Promise.resolve(project);
          if (entity === McCharacterKit) return Promise.resolve(kit);
          if (entity === AnimationAsset) return Promise.resolve(assets[where.id] ?? null);
          return Promise.resolve(null);
        }),
      })),
      transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
        cb(manager as unknown as EntityManager),
      ),
      query: jest.fn().mockResolvedValue([{ establishment: { tradeName: 'Mercadão' } }]),
    };
    processor = new McScriptProcessor(
      dataSource as unknown as DataSource,
      {
        casTransition: jest.fn().mockResolvedValue(true),
        notify: jest.fn().mockResolvedValue(undefined),
      } as unknown as TaskTransitionService,
      { appendEvent: jest.fn().mockResolvedValue(undefined) } as unknown as CommercialsService,
      { refundUnconsumed: jest.fn() } as unknown as CreditsService,
    );
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = originalProvider;
  });

  const saved = (): McScript =>
    (
      manager.update.mock.calls.find(([entity]) => entity === McProject) as [
        unknown,
        unknown,
        { script: McScript },
      ]
    )[2].script;

  it('arte que fala sem o modo: roteiro sem os campos novos e janela com o aspecto do tile de busto', async () => {
    await processor.process({ stepId: 'st' });
    const script = saved();
    expect(script).not.toHaveProperty('cutout');
    expect(script).not.toHaveProperty('framing');
    expect(script).not.toHaveProperty('cutoutKeyColor');
    // janela 3:4 (busto) no quadro 1080×1920
    const w = script.window!;
    expect((w.w * 1080) / (w.h * 1920)).toBeCloseTo(0.75, 2);
  });

  it('arte que fala sem fundo + corpo: cutout, framing e a chave do tile de corpo congelados; janela com o aspecto do corpo', async () => {
    project.options = { ...(project.options as object), cutout: true, framing: 'corpo' };
    await processor.process({ stepId: 'st' });
    const script = saved();
    expect(script).toMatchObject({ cutout: true, framing: 'corpo', cutoutKeyColor: '#0047BB' });
    const w = script.window!;
    expect((w.w * 1080) / (w.h * 1920)).toBeCloseTo(0.5, 2);
  });

  it('arte que fala em Card com corpo: framing corpo sem cutout nem chave', async () => {
    project.options = { ...(project.options as object), framing: 'corpo' };
    await processor.process({ stepId: 'st' });
    const script = saved();
    expect(script).toMatchObject({ framing: 'corpo' });
    expect(script).not.toHaveProperty('cutout');
    expect(script).not.toHaveProperty('cutoutKeyColor');
  });

  it('peça de ofertas sem fundo: o roteiro leva cutout, framing e a chave; Card segue sem os campos', async () => {
    project.format = 'offer_piece';
    project.pieceSnapshot = fixturePieceDocument({
      character: { panel: { shape: 'none', color: '#FFFFFF' } },
    });
    await processor.process({ stepId: 'st' });
    expect(saved()).toMatchObject({ cutout: true, framing: 'corpo', cutoutKeyColor: '#0047BB' });

    manager.update.mockClear();
    project.pieceSnapshot = fixturePieceDocument();
    await processor.process({ stepId: 'st' });
    const card = saved();
    expect(card).not.toHaveProperty('cutout');
    expect(card).not.toHaveProperty('framing');
  });
});
