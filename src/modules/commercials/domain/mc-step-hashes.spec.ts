import {
  computeAssemblyHash,
  computeKeyframeHashV2,
  computeKitReferenceHash,
  computeKitReferenceRequestHash,
  computeSceneStepHashes,
  computeTalkHashV2,
  KeyframeHashInputV2,
  KitReferenceHashInput,
  SceneHashContext,
  TalkHashInputV2,
} from './mc-step-hashes';

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

/**
 * Change video-formatos-personagem (D1/D5): estilo fixo no hash do keyframe
 * (só quando definido — kit anterior mantém o hash) e hash do kit com estilo,
 * cor de fundo, imagem de origem, slot, prompt, origem e modelo.
 */
describe('mc-step-hashes — estilo e cor de fundo (D1/D5)', () => {
  it('keyframe legado: estilo definido muda o hash; nulo ou ausente mantém o hash de antes', () => {
    const before = computeSceneStepHashes(base);
    expect(computeSceneStepHashes({ ...base, style: null }).keyframe).toBe(before.keyframe);
    expect(computeSceneStepHashes({ ...base, style: 'cartoon_2d' }).keyframe).not.toBe(
      before.keyframe,
    );
    expect(computeSceneStepHashes({ ...base, style: 'cartoon_2d' }).keyframe).not.toBe(
      computeSceneStepHashes({ ...base, style: '3d_render' }).keyframe,
    );
    // tts não depende do estilo
    expect(computeSceneStepHashes({ ...base, style: '3d_render' }).tts).toBe(before.tts);
  });

  it('keyframe v2: estilo muda o hash; null e undefined são o mesmo hash (kit anterior)', () => {
    const kf: KeyframeHashInputV2 = {
      kitId: 'kit-1',
      kitVersion: 1,
      aspectRatio: '9:16',
      initialFramePrompt: 'mascot by the shelf',
      promptLang: 'en',
      references: [{ assetId: 'r0', role: 'identity', slot: 2, reason: 'front' }],
      environment: null,
      attempt: 1,
    };
    const legacy = computeKeyframeHashV2(kf);
    expect(computeKeyframeHashV2({ ...kf, style: null })).toBe(legacy);
    expect(computeKeyframeHashV2({ ...kf, style: 'realistic' })).not.toBe(legacy);
    expect(computeKeyframeHashV2({ ...kf, style: 'realistic' })).not.toBe(
      computeKeyframeHashV2({ ...kf, style: 'cartoon_2d' }),
    );
  });

  it('kit: estilo, cor de fundo, imagem, slot, prompt, origem e modelo invalidam; é estável', () => {
    const input: KitReferenceHashInput = {
      slot: 2,
      prompt: 'Expression reference: front view',
      sourceImageHash: 'a'.repeat(64),
      source: 'mascot',
      style: 'cartoon_2d',
      backgroundColor: 'light gray',
      model: 'nano-banana-pro-preview',
    };
    const h = computeKitReferenceHash(input);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeKitReferenceHash({ ...input })).toBe(h);
    expect(computeKitReferenceHash({ ...input, style: '3d_render' })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, style: null })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, backgroundColor: '#1E90FF' })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, sourceImageHash: 'b'.repeat(64) })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, slot: 0 })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, prompt: 'other' })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, source: 'logo' })).not.toBe(h);
    expect(computeKitReferenceHash({ ...input, model: 'other' })).not.toBe(h);
  });

  it('chave de idempotência da referência (2.6): modelo PEDIDO no lugar do efetivo; mesmos invalidadores', () => {
    const { model: _model, ...rest } = {
      slot: 2,
      prompt: 'Expression reference: front view',
      sourceImageHash: 'a'.repeat(64),
      source: 'mascot' as const,
      style: 'cartoon_2d' as const,
      backgroundColor: 'light gray',
      model: 'nano-banana-pro-preview',
    };
    const input = { ...rest, requestedModel: 'gemini-nano-banana-2.1' };
    const h = computeKitReferenceRequestHash(input);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeKitReferenceRequestHash({ ...input })).toBe(h);
    // não colide com o hash do conteúdo, mesmo com o mesmo modelo
    expect(h).not.toBe(computeKitReferenceHash({ ...rest, model: 'gemini-nano-banana-2.1' }));
    expect(computeKitReferenceRequestHash({ ...input, requestedModel: 'x' })).not.toBe(h);
    expect(computeKitReferenceRequestHash({ ...input, slot: 1 })).not.toBe(h);
    expect(computeKitReferenceRequestHash({ ...input, prompt: 'other' })).not.toBe(h);
    expect(computeKitReferenceRequestHash({ ...input, sourceImageHash: 'b'.repeat(64) })).not.toBe(
      h,
    );
    expect(computeKitReferenceRequestHash({ ...input, style: null })).not.toBe(h);
    expect(computeKitReferenceRequestHash({ ...input, backgroundColor: '#fff' })).not.toBe(h);
    expect(computeKitReferenceRequestHash({ ...input, source: 'logo' })).not.toBe(h);
  });
});

describe('mc-step-hashes — talk (change video-formatos-personagem, D1/D2/D7)', () => {
  const base: TalkHashInputV2 = {
    engineModel: 'fal-ai/kling-video/ai-avatar/v2/standard',
    tileAssetId: 'tile-1',
    audioAssetId: 'au-1',
    prompt: 'Waves. Static medium shot.',
    backgroundColor: '#FF8800',
    attempt: 1,
  };

  it('é estável e muda com motor, tile, áudio, prompt, cor de fundo e tentativa', () => {
    expect(computeTalkHashV2(base)).toBe(computeTalkHashV2({ ...base }));
    expect(computeTalkHashV2(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeTalkHashV2({ ...base, engineModel: 'fal-ai/kling-video/ai-avatar/v2/pro' }),
    ).not.toBe(computeTalkHashV2(base));
    expect(computeTalkHashV2({ ...base, tileAssetId: 'tile-2' })).not.toBe(computeTalkHashV2(base));
    expect(computeTalkHashV2({ ...base, audioAssetId: 'au-2' })).not.toBe(computeTalkHashV2(base));
    expect(computeTalkHashV2({ ...base, prompt: 'Nods. Static medium shot.' })).not.toBe(
      computeTalkHashV2(base),
    );
    expect(computeTalkHashV2({ ...base, attempt: 2 })).not.toBe(computeTalkHashV2(base));
  });

  it('cor da janela alterada → hash novo (clipe regerado; o TTS é outro step e não muda)', () => {
    expect(computeTalkHashV2({ ...base, backgroundColor: '#00FF00' })).not.toBe(
      computeTalkHashV2(base),
    );
    // a mesma cor em caixa diferente é a mesma requisição
    expect(computeTalkHashV2({ ...base, backgroundColor: ' #ff8800 ' })).toBe(
      computeTalkHashV2(base),
    );
  });
});
