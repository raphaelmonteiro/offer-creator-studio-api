import { computeComposeFfmpegHash, computeTalkHashV2 } from './mc-step-hashes';
import {
  buildChunkTalkStep,
  chunkNeedsSplice,
  chunkPlanFromSnapshot,
  ChunkStepContext,
  readChunkSnapshot,
} from './mc-talk-chunk-step';
import { planTalkChunks } from './mc-talk-chunks';
import { KLING_AVATAR_MODEL, MINIMAX_H3_LIPSYNC_MODEL } from './mc-pipeline.config';

const ctx = (model = KLING_AVATAR_MODEL): ChunkStepContext => ({
  tileAssetId: 'tile-1',
  tileWidth: 720,
  tileHeight: 960,
  backgroundColor: '#FF8800',
  cutout: null,
  tier: 'economico',
  identityMode: 'generated',
  engine: { key: 'economico', model, usdPerSecond: 0.0562, maxChunkS: 15 },
});

function plan(durations: number[], model = KLING_AVATAR_MODEL) {
  return planTalkChunks({
    speeches: durations.map((durationMs, i) => ({ sceneId: `row-${i}`, durationMs })),
    engineModel: model,
    engineMaxChunkS: 15,
    chunkMaxS: 10,
  }).chunks;
}

const speeches = (n: number, from = 0) =>
  Array.from({ length: n }, (_v, i) => ({
    sceneRowId: `row-${from + i}`,
    sceneId: `s${from + i}`,
    audioAssetId: `au-${from + i}`,
  }));

const base = (
  chunkIndex: number,
  durations: number[],
  join: Parameters<typeof buildChunkTalkStep>[0]['join'],
) => {
  const chunks = plan(durations);
  const chunk = chunks[chunkIndex];
  return buildChunkTalkStep({
    ctx: ctx(),
    chunk,
    speeches: speeches(chunk.sceneIds.length, chunkIndex * 2),
    join,
    motion: '',
    lang: 'pt',
    sceneType: 'talk_tile',
    attempt: 1,
    count: chunks.length,
  });
};

describe('buildChunkTalkStep (D6/D10)', () => {
  it('uma fala sem cauda nem junção → hash e prompt LEGADOS (cache reaproveitado entre modos)', () => {
    const out = base(0, [4300], null);
    const legacy = computeTalkHashV2({
      engineModel: KLING_AVATAR_MODEL,
      tileAssetId: 'tile-1',
      audioAssetId: 'au-0',
      prompt: (out.snapshot as { prompt: string }).prompt,
      backgroundColor: '#FF8800',
      attempt: 1,
    });
    expect(out.inputHash).toBe(legacy);
    expect((out.snapshot as { prompt: string }).prompt).toContain('Start and end in a neutral');
  });

  it('várias falas: o hash leva o bloco do trecho e o prompt é o contínuo; a ordem das falas importa', () => {
    const a = base(0, [2000, 2000, 2000], null);
    expect((a.snapshot as { prompt: string }).prompt).toContain('one continuous take');
    const legacy = computeTalkHashV2({
      engineModel: KLING_AVATAR_MODEL,
      tileAssetId: 'tile-1',
      audioAssetId: 'au-0',
      prompt: (a.snapshot as { prompt: string }).prompt,
      backgroundColor: '#FF8800',
      attempt: 1,
    });
    expect(a.inputHash).not.toBe(legacy);
    const other = base(0, [2000, 2500, 2000], null);
    expect(other.inputHash).not.toBe(a.inputHash);
  });

  it('a junção encadeia: trocar o hash do trecho anterior muda o deste', () => {
    const j1 = base(1, [4300, 4300, 4300, 4300], { fromStepHash: 'h1', fromSceneRowId: 'row-0' });
    const j2 = base(1, [4300, 4300, 4300, 4300], { fromStepHash: 'h2', fromSceneRowId: 'row-0' });
    expect(j1.inputHash).not.toBe(j2.inputHash);
    const chunk = readChunkSnapshot(j1.snapshot)!;
    expect(chunk.join).toEqual({ fromChunkIndex: 0, fromStepHash: 'h1', fromSceneRowId: 'row-0' });
    expect(chunk).toMatchObject({ index: 1, count: 2, tailMs: 0, gapMs: 200 });
  });

  it('tentativa nova muda o hash; o snapshot guarda o motor, o tile e as falas com instantes', () => {
    const chunks = plan([2000, 2000]);
    const first = base(0, [2000, 2000], null);
    const second = buildChunkTalkStep({
      ctx: ctx(),
      chunk: chunks[0],
      speeches: speeches(2),
      join: null,
      motion: '',
      lang: 'pt',
      sceneType: 'talk_tile',
      attempt: 2,
      count: 1,
    });
    expect(second.inputHash).not.toBe(first.inputHash);
    expect(first.snapshot).toMatchObject({
      tileAssetId: 'tile-1',
      audioAssetId: 'au-0',
      engine: { model: KLING_AVATAR_MODEL },
    });
    expect(readChunkSnapshot(first.snapshot)!.speeches.map((s) => s.startMs)).toEqual([0, 2200]);
  });
});

describe('plano do trecho a partir do snapshot', () => {
  it('H3: o enchimento único usa o motor EFETIVO (fallback para o tier não enche)', () => {
    const chunk = readChunkSnapshot(base(0, [2000, 2000], null).snapshot)!;
    expect(chunkPlanFromSnapshot(chunk, KLING_AVATAR_MODEL).sentMs).toBe(chunk.audioMs);
    expect(chunkPlanFromSnapshot(chunk, MINIMAX_H3_LIPSYNC_MODEL).sentMs).toBe(5150);
  });

  it('uma fala solta sem cauda vai como está; várias ou com cauda precisam da emenda', () => {
    expect(chunkNeedsSplice({ speeches: [{}] as never, tailMs: 0 })).toBe(false);
    expect(chunkNeedsSplice({ speeches: [{}] as never, tailMs: 200 })).toBe(true);
    expect(chunkNeedsSplice({ speeches: [{}, {}] as never, tailMs: 0 })).toBe(true);
    expect(readChunkSnapshot({})).toBeNull();
  });
});

describe('hash do compose_ffmpeg — modo contínuo (D9/D10)', () => {
  const input = {
    clips: [{ sceneId: 's1', finalAssetId: 'f1' }],
    backgroundArtAssetId: null,
    aspectRatio: '4:5',
    window: null,
    logoFace: false,
    backgroundColor: '#FFFFFF',
    gapMs: 200,
    captionsEnabled: true,
    endcard: null,
    graphVersion: 2,
  };

  it('só entra quando presente: ausente/nulo = hash de hoje', () => {
    expect(computeComposeFfmpegHash({ ...input, continuous: null })).toBe(
      computeComposeFfmpegHash(input),
    );
    expect(computeComposeFfmpegHash({ ...input, continuous: { version: 1 } })).not.toBe(
      computeComposeFfmpegHash(input),
    );
  });
});
