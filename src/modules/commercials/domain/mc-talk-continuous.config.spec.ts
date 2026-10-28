import {
  assertTalkContinuousEnv,
  effectiveChunkMaxS,
  isTalkContinuousEnabled,
  talkChunkMaxS,
  talkPollPerAudioS,
  talkPollTimeoutMs,
} from './mc-talk-continuous.config';

describe('mc-talk-continuous.config', () => {
  it('flag desligada por padrão; só "true" liga', () => {
    expect(isTalkContinuousEnabled({})).toBe(false);
    expect(isTalkContinuousEnabled({ MC_TALK_CONTINUOUS: 'false' })).toBe(false);
    expect(isTalkContinuousEnabled({ MC_TALK_CONTINUOUS: ' TRUE ' })).toBe(true);
  });

  it('teto do trecho: padrão 10, vazio = motor, inválido derruba o boot', () => {
    expect(talkChunkMaxS({})).toBe(10);
    expect(talkChunkMaxS({ MC_TALK_CHUNK_MAX_S: '8' })).toBe(8);
    expect(talkChunkMaxS({ MC_TALK_CHUNK_MAX_S: '' })).toBeNull();
    expect(() => talkChunkMaxS({ MC_TALK_CHUNK_MAX_S: 'abc' })).toThrow(/MC_TALK_CHUNK_MAX_S/);
    expect(() => talkChunkMaxS({ MC_TALK_CHUNK_MAX_S: '0' })).toThrow();
    expect(() => assertTalkContinuousEnv({ MC_TALK_POLL_PER_AUDIO_S: '-1' })).toThrow(/POLL/);
  });

  it('teto efetivo por motor nunca passa do maxChunkS', () => {
    expect(effectiveChunkMaxS(15, {})).toBe(10);
    expect(effectiveChunkMaxS(15, { MC_TALK_CHUNK_MAX_S: '' })).toBe(15);
    expect(effectiveChunkMaxS(8, { MC_TALK_CHUNK_MAX_S: '12' })).toBe(8);
  });

  it('timeout do poll proporcional ao áudio, com piso de 15 min e teto de 40 min', () => {
    const min = 60_000;
    expect(talkPollPerAudioS({})).toBe(150);
    expect(talkPollTimeoutMs(4300, {})).toBe(15 * min);
    expect(talkPollTimeoutMs(10_000, {})).toBe(25 * min);
    expect(talkPollTimeoutMs(15_000, {})).toBe(37.5 * min);
    expect(talkPollTimeoutMs(30_000, {})).toBe(40 * min);
    expect(talkPollTimeoutMs(null, {})).toBe(15 * min);
    expect(talkPollTimeoutMs(10_000, { MC_TALK_POLL_PER_AUDIO_S: '60' })).toBe(15 * min);
  });
});
