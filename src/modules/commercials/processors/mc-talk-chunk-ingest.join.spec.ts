import * as fs from 'fs/promises';
import { ChunkSnapshot } from '../domain/mc-talk-chunk-step';
import { createIngestHarness } from './mc-talk-chunk-ingest.fixture';

describe('McTalkChunkIngest — junção entre trechos (D7)', () => {
  let h: Awaited<ReturnType<typeof createIngestHarness>>;
  beforeEach(async () => {
    h = await createIngestHarness();
  });
  afterEach(() => fs.rm(h.tempDir, { recursive: true, force: true }));

  const asJoined = (over: Partial<ChunkSnapshot>) => {
    h.chunk = { ...h.chunk, ...over };
  };

  it('trecho com sucessor: guarda o ÚLTIMO quadro da última fatia como asset talk_join_frame e o aponta na líder', async () => {
    asJoined({ index: 0, count: 2 });
    await h.run();
    const frame = h.saved.find((a) => a.kind === 'talk_join_frame')!;
    expect(frame).toMatchObject({ mimeType: 'image/png', userId: 'u1' });
    expect(frame.metadata).toMatchObject({ chunkIndex: 0, sourceStepId: 'st-chunk' });
    const leader = h.saved.find((a) => a.kind === 'scene_synced')!;
    expect((leader.metadata as { joinFrameAssetId: string }).joinFrameAssetId).toBe(frame.id);
    const lastFrameRun = h.ffmpegRuns.find((a) => a.includes('-sseof'))!;
    expect(lastFrameRun[lastFrameRun.indexOf('-i') + 1]).toMatch(/slice-2\.mp4$/);
    const clip = h.helpers.inspect.mock.calls[0][2] as { identityReference: boolean };
    expect(clip.identityReference).toBe(false); // o 1º trecho parte do tile
  });

  it('último trecho não guarda quadro; o que parte de uma junção é inspecionado contra o tile (identity_drift)', async () => {
    asJoined({
      index: 1,
      count: 2,
      join: { fromChunkIndex: 0, fromStepHash: 'h', fromSceneRowId: 'row-0' },
    });
    await h.run();
    expect(h.saved.some((a) => a.kind === 'talk_join_frame')).toBe(false);
    expect(h.ffmpegRuns.some((a) => a.includes('-sseof'))).toBe(false);
    const clip = h.helpers.inspect.mock.calls[0][2] as { identityReference: boolean };
    expect(clip.identityReference).toBe(true);
  });

  it('quadro vazio → chunk_join_frame_missing (terminal, nada publicado como pronto)', async () => {
    asJoined({ index: 0, count: 2 });
    h.flags.emptyPng = true;
    await expect(h.run()).rejects.toMatchObject({ code: 'chunk_join_frame_missing' });
    expect(h.pipeline.completeStepAndAdvance).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(0);
  });
});
