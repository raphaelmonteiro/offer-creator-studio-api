import * as fs from 'fs/promises';
import * as path from 'path';
import { McStepStatus } from '../domain/mc-state-machines';
import { McScene } from '../entities/mc-scene.entity';
import { createIngestHarness } from './mc-talk-chunk-ingest.fixture';

describe('McTalkChunkIngest', () => {
  let h: Awaited<ReturnType<typeof createIngestHarness>>;
  beforeEach(async () => {
    h = await createIngestHarness();
  });
  afterEach(() => fs.rm(h.tempDir, { recursive: true, force: true }));

  it('um único ffmpeg conforma e fatia em 3; o trecho inteiro é inspecionado UMA vez', async () => {
    await h.run();
    const conform = h.ffmpegRuns.filter((a) => a.join(' ').includes('split='));
    expect(conform).toHaveLength(1);
    expect(conform[0].join(' ')).toContain('split=4');
    expect(h.helpers.inspect).toHaveBeenCalledTimes(1);
    const clip = h.helpers.inspect.mock.calls[0][2] as { path: string; speechWindows: unknown[] };
    expect(path.basename(clip.path)).toBe('chunk-full.mp4');
  });

  it('publica uma fatia por cena e o trecho inteiro; só a líder leva custo, motor e a lista de fatias', async () => {
    await h.run();
    const slices = h.saved.filter((a) => a.kind === 'scene_synced');
    const full = h.saved.filter((a) => a.kind === 'talk_chunk_clip');
    expect(slices).toHaveLength(3);
    expect(full).toHaveLength(1);
    const meta = slices.map((a) => a.metadata as Record<string, unknown>);
    expect(meta.map((m) => m.sceneId)).toEqual(['row-0', 'row-1', 'row-2']);
    expect(meta.map((m) => [m.speechMs, m.joinedToNext])).toEqual([
      [2168, true],
      [1907, true],
      [4310, false],
    ]);
    expect(meta[0].providerCostUsd).toBe(0.4937);
    expect(meta[0].billedDurationMs).toBe(8785);
    expect(meta[1]).not.toHaveProperty('providerCostUsd');
    expect(meta[2]).not.toHaveProperty('providerCostUsd');
    const listed = (meta[0].chunkSlices as Array<{ assetId: string }>).map((s) => s.assetId);
    expect(listed).toEqual(slices.map((a) => a.id));
    expect((full[0].metadata as { slices: unknown[] }).slices).toHaveLength(3);
    expect(meta[0].conform).toMatchObject({ audioMs: 8785, audioPolicy: 'replace_clip_audio' });
  });

  it('na MESMA transação: seguidoras ready com a fatia delas e o step concluído com o asset da líder e o custo do trecho', async () => {
    await h.run();
    const slices = h.saved.filter((a) => a.kind === 'scene_synced');
    expect(h.pipeline.markChunkSceneReady).toHaveBeenCalledTimes(2);
    expect(
      h.pipeline.markChunkSceneReady.mock.calls.map((c) => [(c[2] as McScene).id, c[3]]),
    ).toEqual([
      ['row-1', slices[1].id],
      ['row-2', slices[2].id],
    ]);
    expect(h.pipeline.completeStepAndAdvance).toHaveBeenCalledWith(
      expect.anything(),
      h.step,
      expect.objectContaining({
        from: McStepStatus.INGESTING,
        outputAssetId: slices[0].id,
        providerCostUsd: 0.4937,
        consumeOnSuccess: false,
      }),
    );
    const order = [
      ...h.pipeline.markChunkSceneReady.mock.invocationCallOrder,
      h.pipeline.completeStepAndAdvance.mock.invocationCallOrder[0],
    ];
    expect(order[2]).toBeGreaterThan(order[1]); // as seguidoras antes da conclusão que avança o scheduler
  });

  it('clipe curto demais (> 300 ms) reprova como clip_too_short ANTES de gastar ffmpeg de fatiamento', async () => {
    await expect(h.run(6000)).rejects.toMatchObject({ code: 'clip_too_short' });
    expect(h.ffmpegRuns.filter((a) => a.join(' ').includes('split='))).toHaveLength(0);
    expect(h.pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
  });
});
