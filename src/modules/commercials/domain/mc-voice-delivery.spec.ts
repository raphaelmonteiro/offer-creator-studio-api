import { computeTtsHashV2 } from './mc-step-hashes';
import {
  MC_VOICE_DELIVERY_DEFAULT,
  elevenLabsVoiceSettings,
  kitVoiceDelivery,
  mergeVoiceDelivery,
  resolveVoiceDelivery,
  sanitizeVoiceDeliveryOverride,
  snapStabilityForModel,
  voiceDeliveryKey,
} from './mc-voice-delivery';

describe('perfil de entrega da voz (velocidade/expressividade)', () => {
  it('default "varejo animado": mais rápido e expressivo que o neutro', () => {
    const d = resolveVoiceDelivery({});
    expect(d).toEqual(MC_VOICE_DELIVERY_DEFAULT);
    expect(d.speed).toBeGreaterThan(1);
    expect(d.style).toBeGreaterThan(0);
  });

  it('env sobrescreve com clamp aos limites da ElevenLabs; lixo cai no default', () => {
    const d = resolveVoiceDelivery({
      MC_TTS_SPEED: '1.9',
      MC_TTS_STYLE: '-3',
      MC_TTS_STABILITY: 'abc',
      MC_TTS_SPEAKER_BOOST: 'false',
    });
    expect(d.speed).toBe(1.2);
    expect(d.style).toBe(0);
    expect(d.stability).toBe(MC_VOICE_DELIVERY_DEFAULT.stability);
    expect(d.speakerBoost).toBe(false);
  });

  it('eleven_v3 só aceita stability 0 / 0.5 / 1; multilingual_v2 recebe o valor contínuo', () => {
    expect(snapStabilityForModel(0.4, 'eleven_v3')).toBe(0.5);
    expect(snapStabilityForModel(0.1, 'eleven_v3')).toBe(0);
    expect(snapStabilityForModel(0.9, 'eleven_v3')).toBe(1);
    expect(snapStabilityForModel(0.4, 'eleven_multilingual_v2')).toBe(0.4);
    const v3 = elevenLabsVoiceSettings(MC_VOICE_DELIVERY_DEFAULT, 'eleven_v3');
    expect(v3).toEqual({
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.45,
      use_speaker_boost: true,
      speed: 1.12,
    });
  });

  it('ajuste do kit vence o global campo a campo, com clamp; lixo/vazio = global', () => {
    const base = resolveVoiceDelivery({});
    expect(mergeVoiceDelivery(base, { speed: 0.5, style: 0.9 })).toEqual({
      ...base,
      speed: 0.7,
      style: 0.9,
    });
    expect(mergeVoiceDelivery(base, {})).toBe(base);
    expect(mergeVoiceDelivery(base, null)).toBe(base);
    expect(
      sanitizeVoiceDeliveryOverride({ speed: 'x', style: NaN } as unknown as Record<
        string,
        unknown
      >),
    ).toBeNull();
    expect(kitVoiceDelivery({ voiceDelivery: { speed: 1.0 } }, {}).speed).toBe(1.0);
    expect(kitVoiceDelivery({ voiceDelivery: null }, { MC_TTS_SPEED: '1.2' }).speed).toBe(1.2);
  });

  it('mudar o perfil invalida o cache do TTS (entra no hash); sem perfil o hash é estável', () => {
    const base = { dialogue: 'oi', voiceId: 'v', attempt: 1 };
    const fast = computeTtsHashV2({
      ...base,
      delivery: { ...MC_VOICE_DELIVERY_DEFAULT, speed: 1.2 },
    });
    const slow = computeTtsHashV2({
      ...base,
      delivery: { ...MC_VOICE_DELIVERY_DEFAULT, speed: 1.0 },
    });
    expect(fast).not.toBe(slow);
    expect(computeTtsHashV2(base)).toBe(computeTtsHashV2({ ...base, delivery: null }));
    expect(voiceDeliveryKey(MC_VOICE_DELIVERY_DEFAULT)).toBe('st0.4|si0.75|sy0.45|sp1.12|b1');
  });
});
