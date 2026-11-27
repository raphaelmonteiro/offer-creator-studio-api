import { AnimationAsset } from '../../../shared/media-assets/animation-asset.entity';
import { fixturePieceDocument } from '../domain/__fixtures__/mc-piece.fixtures';
import { MC_PIPELINE_V2 } from '../domain/mc-quality';
import { McScriptProcessor } from './mc-script.processor';
import { newScriptProcessor } from './mc-script.processor.testutil';

/** O step `script` congela modo sem fundo, enquadramento e cor-chave (video-mascote-transparente, D9). */
describe('McScriptProcessor — roteiro com personagem sem fundo (F1 e peça)', () => {
  const originalProvider = process.env.MC_SCRIPT_PROVIDER;
  let project: Record<string, unknown>;
  let kit: Record<string, unknown>;
  let manager: ReturnType<typeof newScriptProcessor>['manager'];
  let processor: McScriptProcessor;
  let saved: ReturnType<typeof newScriptProcessor>['saved'];

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
    ({ processor, manager, saved } = newScriptProcessor({
      project,
      kit,
      lookup: (entity, where) =>
        entity === AnimationAsset ? (assets[where.id] ?? null) : undefined,
    }));
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.MC_SCRIPT_PROVIDER;
    else process.env.MC_SCRIPT_PROVIDER = originalProvider;
  });

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
