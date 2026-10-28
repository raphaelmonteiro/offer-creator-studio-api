import {
  buildChunkConformSliceArgs,
  buildChunkSpliceArgs,
  buildLastFrameArgs,
  planChunkSlices,
} from './mc-talk-chunk-ffmpeg';
import { ChunkSnapshot } from './mc-talk-chunk-step';
import { planChunkAudioSplice, planTalkChunks } from './mc-talk-chunks';
import { planTalkConform } from './mc-talk-conform-graph';
import { MINIMAX_H3_LIPSYNC_MODEL } from './mc-pipeline.config';

const chunkOf = (durations: number[], model = 'fal-ai/kling-video/ai-avatar/v2/standard') =>
  planTalkChunks({
    speeches: durations.map((durationMs, i) => ({ sceneId: `r${i}`, durationMs })),
    engineModel: model,
    engineMaxChunkS: 15,
    chunkMaxS: 10,
  }).chunks[0];

describe('buildChunkSpliceArgs (D5)', () => {
  const args = (durations: number[], format: 'mp3' | 'wav', withPad = true, model?: string) => {
    const chunk = chunkOf(durations, model);
    return buildChunkSpliceArgs({
      inputs: durations.map((_d, i) => `/tmp/tts-${i}.mp3`),
      plan: planChunkAudioSplice(chunk),
      output: `/tmp/out.${format}`,
      format,
      withPad,
    });
  };

  it('cada TTS ajustado à duração medida, silêncios exatos da timeline e concat, sem atempo', () => {
    const joined = args([2168, 1907, 4310], 'mp3').join(' ');
    expect(joined).toContain('atrim=0:2.168');
    expect(joined).toContain('apad=whole_dur=2.168');
    expect(joined).toContain('anullsrc=r=44100:cl=mono,atrim=0:0.200');
    expect(joined).toContain('concat=n=5:v=0:a=1[out]'); // 3 falas + 2 silêncios
    expect(joined).toContain('-t 8.785');
    expect(joined).toContain('libmp3lame');
    expect(joined).not.toContain('atempo');
  });

  it('H3: enchimento ÚNICO ao fim do trecho (nunca por fala); sem enchimento para a trilha das fatias', () => {
    const padded = args([2000, 2000], 'mp3', true, MINIMAX_H3_LIPSYNC_MODEL).join(' ');
    expect(padded).toContain('-t 5.150');
    expect(padded.match(/anullsrc/g)).toHaveLength(2); // gap + pad
    const wav = args([2000, 2000], 'wav', false, MINIMAX_H3_LIPSYNC_MODEL).join(' ');
    expect(wav).toContain('-t 4.200');
    expect(wav).toContain('pcm_s16le');
    expect(wav.match(/anullsrc/g)).toHaveLength(1);
  });

  it('cauda de junção entra como silêncio depois da última fala', () => {
    const chunk = planTalkChunks({
      speeches: [4300, 4300, 4300, 4300].map((durationMs, i) => ({ sceneId: `r${i}`, durationMs })),
      engineModel: 'fal-ai/kling-video/ai-avatar/v2/standard',
      engineMaxChunkS: 15,
      chunkMaxS: 10,
    }).chunks[0];
    const joined = buildChunkSpliceArgs({
      inputs: ['a', 'b'],
      plan: planChunkAudioSplice(chunk),
      output: 'o.mp3',
      format: 'mp3',
      withPad: true,
    }).join(' ');
    expect(joined).toContain('-t 9.000'); // 4,3 + 0,2 + 4,3 + 0,2 de cauda
    expect(joined).toContain('concat=n=4');
  });
});

describe('planChunkSlices + buildChunkConformSliceArgs (D8)', () => {
  const snapshot = (durations: number[]): ChunkSnapshot => {
    const chunk = chunkOf(durations);
    return {
      version: 1,
      index: 0,
      count: 1,
      sceneIds: chunk.sceneIds,
      sceneRowIds: chunk.sceneIds,
      speeches: chunk.speeches.map((s) => ({
        ...s,
        sceneRowId: s.sceneId,
        audioAssetId: `au-${s.sceneId}`,
      })),
      gapMs: chunk.gapMs,
      tailMs: chunk.tailMs,
      audioMs: chunk.audioMs,
      sentMs: chunk.sentMs,
      offsetMs: 0,
      ownHash: 'h',
      join: null,
    };
  };

  it('a fatia cobre fala + silêncio seguinte; a última, fala + cauda', () => {
    const slices = planChunkSlices(snapshot([2168, 1907, 4310]));
    expect(slices.map((s) => [s.startMs, s.endMs, s.speechMs, s.joinedToNext])).toEqual([
      [0, 2368, 2168, true],
      [2368, 4475, 1907, true],
      [4475, 8785, 4310, false],
    ]);
  });

  it('um único passe: conform + split + trim por fatia, áudio cortado nos mesmos instantes, trecho inteiro leve', () => {
    const snap = snapshot([2168, 1907, 4310]);
    const slices = planChunkSlices(snap);
    const args = buildChunkConformSliceArgs({
      videoPath: 'raw.mp4',
      audioPath: 'voice.wav',
      plan: planTalkConform({
        videoMs: 8900,
        audioMs: snap.audioMs,
        videoWidth: 720,
        videoHeight: 960,
        tileWidth: 720,
        tileHeight: 960,
      }),
      slices,
      audioMs: snap.audioMs,
      sliceOutputs: ['s0.mp4', 's1.mp4', 's2.mp4'],
      fullOutput: 'full.mp4',
    });
    const joined = args.join(' ');
    expect(joined).toContain('split=4');
    expect(joined).toContain('trim=start=2.368:end=4.475');
    expect(joined).toContain('atrim=start=4.475:end=8.785');
    expect(args.filter((a) => a.endsWith('.mp4'))).toEqual([
      'raw.mp4',
      's0.mp4',
      's1.mp4',
      's2.mp4',
      'full.mp4',
    ]);
    expect(joined).toContain('-preset ultrafast'); // o trecho inteiro só serve à inspeção
    expect(joined).not.toContain('atempo');
  });

  it('uma fatia só dispensa o arquivo do trecho inteiro; plano too_short não gera comando', () => {
    const snap = snapshot([4000]);
    const plan = planTalkConform({
      videoMs: 4000,
      audioMs: snap.audioMs,
      videoWidth: 720,
      videoHeight: 960,
      tileWidth: 720,
      tileHeight: 960,
    });
    const one = buildChunkConformSliceArgs({
      videoPath: 'raw.mp4',
      audioPath: 'voice.wav',
      plan,
      slices: planChunkSlices(snap),
      audioMs: snap.audioMs,
      sliceOutputs: ['s0.mp4'],
      fullOutput: 'full.mp4',
    });
    expect(one.join(' ')).toContain('split=1');
    expect(one).not.toContain('full.mp4');
    expect(() =>
      buildChunkConformSliceArgs({
        videoPath: 'raw.mp4',
        audioPath: 'voice.wav',
        plan: { ...plan, durationAction: 'too_short' },
        slices: planChunkSlices(snap),
        audioMs: snap.audioMs,
        sliceOutputs: ['s0.mp4'],
        fullOutput: null,
      }),
    ).toThrow(/too_short/);
  });

  it('último quadro: lê só o final do clipe e sobrescreve o PNG a cada quadro', () => {
    const args = buildLastFrameArgs({ video: 'c.mp4', output: 'f.png' });
    expect(args).toEqual(expect.arrayContaining(['-sseof', '-0.1', '-update', '1']));
    expect(args).not.toContain('-frames:v');
    expect(args[args.length - 1]).toBe('f.png');
  });
});
