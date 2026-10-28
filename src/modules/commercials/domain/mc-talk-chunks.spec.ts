import { buildSpeechTimeline } from './mc-talk-conform-graph';
import {
  planChunkAudioSplice,
  planTalkChunks,
  talkChunkMaxMs,
  TalkChunkPlan,
} from './mc-talk-chunks';
import { KLING_AVATAR_MODEL, MINIMAX_H3_LIPSYNC_MODEL } from './mc-pipeline.config';

const speech = (sceneId: string, durationMs: number) => ({ sceneId, durationMs });
const kling = { engineModel: KLING_AVATAR_MODEL, engineMaxChunkS: 15, chunkMaxS: 10 };

describe('talkChunkMaxMs', () => {
  it('usa o menor entre o teto do motor e MC_TALK_CHUNK_MAX_S; vazio ou inválido = teto do motor', () => {
    expect(talkChunkMaxMs(15, 10)).toBe(10_000);
    expect(talkChunkMaxMs(15, 20)).toBe(15_000);
    expect(talkChunkMaxMs(15, null)).toBe(15_000);
    expect(talkChunkMaxMs(15, 0)).toBe(15_000);
  });
});

describe('planTalkChunks (D4)', () => {
  it('3 falas do Piccin cabem em 1 trecho de 8,785 s, sem cauda', () => {
    const { chunks, blocked } = planTalkChunks({
      ...kling,
      speeches: [speech('a', 2168), speech('b', 1907), speech('c', 4310)],
    });
    expect(blocked).toEqual([]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      sceneIds: ['a', 'b', 'c'],
      tailMs: 0,
      audioMs: 8785,
      sentMs: 8785,
      offsetMs: 0,
      joinFromIndex: null,
    });
    expect(chunks[0].speeches.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 2168],
      [2368, 4275],
      [4475, 8785],
    ]);
  });

  it('6 falas de 4,3 s (26 s) com teto 10 s viram 3 trechos de 2 falas, com cauda nos que têm sucessor', () => {
    const { chunks } = planTalkChunks({
      ...kling,
      speeches: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => speech(id, 4300)),
    });
    expect(chunks.map((c) => c.sceneIds)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    expect(chunks.map((c) => c.tailMs)).toEqual([200, 200, 0]);
    expect(chunks.map((c) => c.audioMs)).toEqual([9000, 9000, 8800]);
    expect(chunks.map((c) => c.joinFromIndex)).toEqual([null, 0, 1]);
    expect(chunks.every((c) => c.audioMs <= 10_000)).toBe(true);
  });

  it('instantes absolutos (offset + relativo) iguais aos de buildSpeechTimeline', () => {
    const speeches = [speech('a', 4300), speech('b', 4300), speech('c', 3000), speech('d', 5200)];
    const { chunks } = planTalkChunks({ ...kling, speeches });
    const expected = buildSpeechTimeline(speeches).entries;
    const actual = chunks.flatMap((c) =>
      c.speeches.map((s) => ({
        sceneId: s.sceneId,
        startMs: c.offsetMs + s.startMs,
        endMs: c.offsetMs + s.endMs,
      })),
    );
    expect(actual).toEqual(expected);
  });

  it('fala única: 1 trecho sem cauda e sem junção', () => {
    const { chunks } = planTalkChunks({ ...kling, speeches: [speech('a', 3000)] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ tailMs: 0, audioMs: 3000, sentMs: 3000 });
    expect(planChunkAudioSplice(chunks[0]).passthrough).toBe(true);
  });

  it('fala entre o teto do trecho (10 s) e o máximo do motor (15 s) fica em trecho próprio', () => {
    const { chunks, blocked } = planTalkChunks({
      ...kling,
      speeches: [speech('a', 3000), speech('b', 12_000), speech('c', 2000)],
    });
    expect(blocked).toEqual([]);
    expect(chunks.map((c) => c.sceneIds)).toEqual([['a'], ['b'], ['c']]);
    expect(chunks[1].audioMs).toBe(12_000);
    expect(chunks[1].tailMs).toBe(0); // a cauda encolhe até caber no teto (mín. 0)
    expect(chunks[0].tailMs).toBe(200);
  });

  it('fala acima do máximo do motor é bloqueada e nenhum trecho é planejado', () => {
    const result = planTalkChunks({
      ...kling,
      speeches: [speech('a', 3000), speech('b', 15_001)],
    });
    expect(result.chunks).toEqual([]);
    expect(result.blocked).toEqual([{ sceneId: 'b', durationMs: 15_001, maxMs: 15_000 }]);
  });

  it('nenhuma fala é dividida nem reordenada', () => {
    const speeches = [speech('a', 6000), speech('b', 6000), speech('c', 1000)];
    const { chunks } = planTalkChunks({ ...kling, speeches });
    expect(chunks.flatMap((c) => c.sceneIds)).toEqual(['a', 'b', 'c']);
    expect(chunks.flatMap((c) => c.speeches.map((s) => s.durationMs))).toEqual([6000, 6000, 1000]);
  });

  it('H3 com 2 falas de 2 s: 1 trecho de 4,2 s completado UMA vez até 5,15 s', () => {
    const { chunks } = planTalkChunks({
      engineModel: MINIMAX_H3_LIPSYNC_MODEL,
      engineMaxChunkS: 15,
      chunkMaxS: 10,
      speeches: [speech('a', 2000), speech('b', 2000)],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ audioMs: 4200, sentMs: 5150 });
    const splice = planChunkAudioSplice(chunks[0]);
    expect(splice.padMs).toBe(950);
    expect(splice.segments.filter((s) => s.kind === 'silence' && s.reason === 'pad')).toHaveLength(
      1,
    );
    expect(splice.totalMs).toBe(5150);
  });

  it('H3: trecho que já passa de 5,15 s não recebe enchimento', () => {
    const { chunks } = planTalkChunks({
      engineModel: MINIMAX_H3_LIPSYNC_MODEL,
      engineMaxChunkS: 15,
      speeches: [speech('a', 3000), speech('b', 3000)],
    });
    expect(chunks[0].sentMs).toBe(chunks[0].audioMs);
    expect(planChunkAudioSplice(chunks[0]).padMs).toBe(0);
  });

  it('sem teto próprio (MC_TALK_CHUNK_MAX_S vazio) usa o máximo do motor', () => {
    const { chunks } = planTalkChunks({
      engineModel: KLING_AVATAR_MODEL,
      engineMaxChunkS: 15,
      speeches: [speech('a', 7000), speech('b', 7000)],
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audioMs).toBe(14_200);
  });

  it('sem falas, sem trechos', () => {
    expect(planTalkChunks({ ...kling, speeches: [] })).toEqual({ chunks: [], blocked: [] });
  });
});

describe('planChunkAudioSplice (D5)', () => {
  it('ordem fala/silêncio da timeline, com cauda, cobrindo exatamente sentMs', () => {
    const { chunks } = planTalkChunks({
      ...kling,
      speeches: [speech('a', 4300), speech('b', 4300), speech('c', 1500)],
    });
    const chunk: TalkChunkPlan = chunks[0];
    const plan = planChunkAudioSplice(chunk);
    expect(plan.segments.map((s) => (s.kind === 'speech' ? s.sceneId : s.reason))).toEqual([
      'a',
      'gap',
      'b',
      'tail',
    ]);
    expect(plan.passthrough).toBe(false);
    const sum = plan.segments.reduce((acc, s) => acc + s.durationMs, 0);
    expect(sum).toBe(plan.totalMs);
    let cursor = 0;
    for (const s of plan.segments) {
      expect(s.startMs).toBe(cursor);
      cursor += s.durationMs;
    }
  });
});
