import { clipInspectionView, sceneClipView, stepClipView } from './mc-clip-view';
import { McStepType } from './mc-types';

describe('visão do clipe — motor e resolução por cena/step (tarefa 7.2)', () => {
  const talkAsset = {
    kind: 'scene_synced',
    width: 1080,
    height: 1440,
    metadata: {
      provider: 'fal-ai/kling-video/ai-avatar/v2/pro',
      engine: { key: 'premium', model: 'fal-ai/kling-video/ai-avatar/v2/pro', usdPerSecond: 0.115 },
      premiumResolutionOk: true,
    },
  };

  it('cena: motor = metadata.engine.model e resolução medida com o veredito do premium', () => {
    expect(sceneClipView(talkAsset)).toEqual({
      engine: 'fal-ai/kling-video/ai-avatar/v2/pro',
      resolution: { width: 1080, height: 1440, premiumResolutionOk: true },
    });
  });

  it('cena legada (lipsync sem engine): motor = provider; ffmpeg/mock não contam como motor', () => {
    expect(
      sceneClipView({
        kind: 'scene_synced',
        width: 720,
        height: 1280,
        metadata: { provider: 'fal-ai/kling-video/ai-avatar/v2/standard' },
      }),
    ).toEqual({
      engine: 'fal-ai/kling-video/ai-avatar/v2/standard',
      resolution: { width: 720, height: 1280, premiumResolutionOk: null },
    });
    expect(
      sceneClipView({ kind: 'scene_synced', width: 720, height: 1280, metadata: {} }).engine,
    ).toBeNull();
  });

  it('asset que não é clipe (keyframe/áudio) ou ausente → sem motor nem resolução', () => {
    expect(sceneClipView({ kind: 'keyframe', width: 720, height: 1280, metadata: {} })).toEqual({
      engine: null,
      resolution: null,
    });
    expect(sceneClipView(null)).toEqual({ engine: null, resolution: null });
  });

  it('step talk antes do ingest: motor EFETIVO do snapshot (fallback), sem resolução', () => {
    const step = {
      type: McStepType.TALK,
      provider: 'fal-ai/kling-video/ai-avatar/v2/pro',
      inputSnapshot: {
        engine: { key: 'logo', model: 'minimax/h3-max/lip-sync/image-to-video' },
        effectiveEngine: {
          key: 'premium',
          model: 'fal-ai/kling-video/ai-avatar/v2/pro',
          fallbackFrom: 'minimax/h3-max/lip-sync/image-to-video',
        },
      },
    };
    expect(stepClipView(step, null)).toEqual({
      engine: 'fal-ai/kling-video/ai-avatar/v2/pro',
      resolution: null,
    });
    // pendente: só o planejado
    expect(
      stepClipView(
        { type: McStepType.TALK, provider: null, inputSnapshot: { engine: { model: 'm/x' } } },
        null,
      ).engine,
    ).toBe('m/x');
  });

  it('step talk concluído: o asset de saída prevalece; steps que não são de motor ficam nulos', () => {
    expect(
      stepClipView({ type: McStepType.TALK, provider: 'x', inputSnapshot: {} }, talkAsset),
    ).toEqual(sceneClipView(talkAsset));
    expect(
      stepClipView({ type: McStepType.TTS, provider: 'elevenlabs', inputSnapshot: {} }, null),
    ).toEqual({ engine: null, resolution: null });
    expect(
      stepClipView(
        { type: McStepType.FINALIZE, provider: 'ffmpeg', inputSnapshot: {} },
        {
          kind: 'commercial_final',
          width: 1080,
          height: 1920,
          metadata: {},
        },
      ),
    ).toEqual({ engine: null, resolution: null });
  });
});

describe('visão do clipe — veredito da inspeção por cena (tarefa 3.7, D11)', () => {
  const clip = (metadata: Record<string, unknown>) => ({
    kind: 'scene_synced',
    width: 1080,
    height: 1440,
    metadata,
  });

  it('inspeção indisponível → "não inspecionado" (a revisão sinaliza a cena)', () => {
    expect(
      clipInspectionView(
        clip({
          inspected: false,
          inspection: {
            available: false,
            verdict: 'não inspecionado',
            mouthCheck: 'skipped',
            flagged: false,
            reasons: [],
            accepted: false,
            executions: 1,
            description: 'MC_CLIP_TEXT_CHECK=off',
          },
        }),
      ),
    ).toEqual({
      verdict: 'não inspecionado',
      inspected: false,
      mouthCheck: 'skipped',
      accepted: false,
      reasons: [],
      executions: 1,
    });
  });

  it('sem alinhamento de fala: inspecionado, boca "skipped" (não verificada)', () => {
    expect(
      clipInspectionView(
        clip({
          inspected: true,
          inspection: {
            available: true,
            verdict: 'ok',
            mouthCheck: 'skipped',
            reasons: [],
            accepted: false,
            executions: 1,
          },
        }),
      ),
    ).toMatchObject({ verdict: 'ok', inspected: true, mouthCheck: 'skipped', accepted: false });
  });

  it('reprovado e aceito no teto: motivos e gerações executadas', () => {
    expect(
      clipInspectionView(
        clip({
          inspected: true,
          inspection: {
            available: true,
            verdict: 'reprovado',
            mouthCheck: 'still',
            reasons: ['mouth_still', 'desconhecido'],
            flagged: true,
            accepted: true,
            executions: 3,
          },
        }),
      ),
    ).toEqual({
      verdict: 'reprovado',
      inspected: true,
      mouthCheck: 'still',
      accepted: true,
      reasons: ['mouth_still'],
      executions: 3,
    });
  });

  it('clipe sem inspeção gravada (mock/legado) ou asset que não é clipe → null', () => {
    expect(clipInspectionView(clip({ provider: 'mock' }))).toBeNull();
    expect(clipInspectionView(null)).toBeNull();
    expect(
      clipInspectionView({
        kind: 'keyframe',
        metadata: { inspected: false, inspection: { available: false } },
      }),
    ).toBeNull();
  });
});
