import { computeAssemblyHash, computeSceneStepHashes, SceneHashContext } from './mc-step-hashes';

const base: SceneHashContext = {
  kitId: 'kit-1',
  kitVersion: 1,
  voiceId: 'voice-1',
  aspectRatio: '9:16',
  actionPrompt: 'Mascote acena para a câmera',
  dialogue: 'Bem-vindo às ofertas!',
  durationS: 10,
  generation: 1,
};

describe('mc-step-hashes — matriz de invalidação (plano §6.3)', () => {
  it('cena falada tem os 4 hashes; muda não tem tts/lipsync', () => {
    const spoken = computeSceneStepHashes(base);
    expect(spoken.keyframe).toMatch(/^[0-9a-f]{64}$/);
    expect(spoken.tts).toMatch(/^[0-9a-f]{64}$/);
    expect(spoken.video).toMatch(/^[0-9a-f]{64}$/);
    expect(spoken.lipsync).toMatch(/^[0-9a-f]{64}$/);

    const mute = computeSceneStepHashes({ ...base, dialogue: null });
    expect(mute.tts).toBeNull();
    expect(mute.lipsync).toBeNull();
  });

  it('re-roll (generation++) muda SÓ video e lipsync — keyframe/tts preservados', () => {
    const gen1 = computeSceneStepHashes(base);
    const gen2 = computeSceneStepHashes({ ...base, generation: 2 });
    expect(gen2.keyframe).toBe(gen1.keyframe);
    expect(gen2.tts).toBe(gen1.tts);
    expect(gen2.video).not.toBe(gen1.video);
    expect(gen2.lipsync).not.toBe(gen1.lipsync);
  });

  it('regravar fala muda tts e lipsync, preserva keyframe (e o video-hash da cadeia sem áudio)', () => {
    const before = computeSceneStepHashes(base);
    const after = computeSceneStepHashes({ ...base, dialogue: 'Ofertas imperdíveis hoje!' });
    expect(after.keyframe).toBe(before.keyframe);
    expect(after.tts).not.toBe(before.tts);
    expect(after.lipsync).not.toBe(before.lipsync);
  });

  it('mudar a ação invalida keyframe e, por encadeamento, video e lipsync', () => {
    const before = computeSceneStepHashes(base);
    const after = computeSceneStepHashes({ ...base, actionPrompt: 'Mascote dança' });
    expect(after.keyframe).not.toBe(before.keyframe);
    expect(after.video).not.toBe(before.video);
    expect(after.lipsync).not.toBe(before.lipsync);
    expect(after.tts).toBe(before.tts); // texto igual — tts preservado (§6.3)
  });

  it('kit novo (version++) invalida keyframe — identidade nova, cena nova', () => {
    const before = computeSceneStepHashes(base);
    const after = computeSceneStepHashes({ ...base, kitVersion: 2 });
    expect(after.keyframe).not.toBe(before.keyframe);
  });

  it('voz diferente invalida o tts', () => {
    const before = computeSceneStepHashes(base);
    const after = computeSceneStepHashes({ ...base, voiceId: 'voice-2' });
    expect(after.tts).not.toBe(before.tts);
  });

  it('assembly-hash muda com generation de qualquer cena, selo e ordem — e é estável', () => {
    const scenes = [
      { idx: 0, generation: 1 },
      { idx: 1, generation: 1 },
    ];
    const h1 = computeAssemblyHash(scenes, null, '9:16');
    expect(computeAssemblyHash(scenes, null, '9:16')).toBe(h1);
    expect(computeAssemblyHash([{ idx: 0, generation: 2 }, scenes[1]], null, '9:16')).not.toBe(h1);
    expect(computeAssemblyHash(scenes, { text: 'Oferta R$ 9,90' }, '9:16')).not.toBe(h1);
    // ordem de entrada não importa (ordenado por idx internamente)
    expect(computeAssemblyHash([scenes[1], scenes[0]], null, '9:16')).toBe(h1);
  });
});
