/**
 * Perfil de ENTREGA da voz (plano §5.3 / pedido do usuário 17/09: "vozes mais
 * animadas e com mais velocidade"). É o `voice_settings` enviado à ElevenLabs
 * no preview E no TTS de produção — o mesmo perfil nos dois, senão a amostra
 * que o usuário aprova não é o que o comercial fala.
 *
 * Verificado na API (17/09): eleven_multilingual_v2 OBEDECE `speed` e `style`
 * (0,7× → 4,9 s; 1,2× → 2,6 s na mesma frase). O eleven_v3 aceita os campos
 * (HTTP 200) mas os IGNORA — por isso o v2 é o modelo principal do módulo. O
 * v3 só aceita `stability` em três presets (0/0.5/1); o valor contínuo é
 * arredondado nesse modelo (usado só como fallback).
 */
export interface McVoiceDelivery {
  /** 0–1: menor = mais variação/emoção (v3: 0 | 0.5 | 1). */
  stability: number;
  /** 0–1: fidelidade ao timbre original. */
  similarityBoost: number;
  /** 0–1: exagero de estilo (expressividade). */
  style: number;
  /** 0.7–1.2: velocidade da fala (1 = natural). */
  speed: number;
  speakerBoost: boolean;
}

/** Default "varejo animado": um pouco mais rápido e expressivo que o neutro da ElevenLabs. */
export const MC_VOICE_DELIVERY_DEFAULT: McVoiceDelivery = {
  stability: 0.4,
  similarityBoost: 0.75,
  style: 0.45,
  speed: 1.12,
  speakerBoost: true,
};

export const MC_VOICE_SPEED_RANGE = { min: 0.7, max: 1.2 } as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

/** Perfil efetivo a partir do ambiente (MC_TTS_SPEED / MC_TTS_STYLE / MC_TTS_STABILITY). */
export function resolveVoiceDelivery(env: NodeJS.ProcessEnv = process.env): McVoiceDelivery {
  const d = MC_VOICE_DELIVERY_DEFAULT;
  return {
    stability: numberEnv(env.MC_TTS_STABILITY, d.stability, 0, 1),
    similarityBoost: numberEnv(env.MC_TTS_SIMILARITY, d.similarityBoost, 0, 1),
    style: numberEnv(env.MC_TTS_STYLE, d.style, 0, 1),
    speed: numberEnv(env.MC_TTS_SPEED, d.speed, MC_VOICE_SPEED_RANGE.min, MC_VOICE_SPEED_RANGE.max),
    speakerBoost:
      env.MC_TTS_SPEAKER_BOOST === undefined ? d.speakerBoost : env.MC_TTS_SPEAKER_BOOST === 'true',
  };
}

/** eleven_v3 só aceita os presets 0 / 0.5 / 1 de stability. */
export function snapStabilityForModel(stability: number, modelId: string): number {
  if (!modelId.startsWith('eleven_v3')) return stability;
  if (stability < 0.25) return 0;
  if (stability < 0.75) return 0.5;
  return 1;
}

/** `voice_settings` da ElevenLabs para o modelo dado. */
export function elevenLabsVoiceSettings(
  delivery: McVoiceDelivery,
  modelId: string,
): Record<string, unknown> {
  return {
    stability: snapStabilityForModel(delivery.stability, modelId),
    similarity_boost: delivery.similarityBoost,
    style: delivery.style,
    use_speaker_boost: delivery.speakerBoost,
    speed: delivery.speed,
  };
}

/** Ajuste escolhido pelo usuário no kit (só o que a UI expõe); ausente = global. */
export type McVoiceDeliveryOverride = Partial<
  Pick<McVoiceDelivery, 'speed' | 'style' | 'stability'>
>;

/** Mantém só campos numéricos válidos, já dentro dos limites; vazio → null. */
export function sanitizeVoiceDeliveryOverride(
  input: Record<string, unknown> | null | undefined,
): McVoiceDeliveryOverride | null {
  if (!input) return null;
  const out: McVoiceDeliveryOverride = {};
  const take = (key: keyof McVoiceDeliveryOverride, min: number, max: number) => {
    const v = input[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clamp(v, min, max);
  };
  take('speed', MC_VOICE_SPEED_RANGE.min, MC_VOICE_SPEED_RANGE.max);
  take('style', 0, 1);
  take('stability', 0, 1);
  return Object.keys(out).length > 0 ? out : null;
}

/** Perfil global + ajuste do kit/preview (o ajuste vence campo a campo). */
export function mergeVoiceDelivery(
  base: McVoiceDelivery,
  override: McVoiceDeliveryOverride | null | undefined,
): McVoiceDelivery {
  const safe = sanitizeVoiceDeliveryOverride(override ?? null);
  return safe ? { ...base, ...safe } : base;
}

/** Perfil efetivo de um kit: ajuste gravado no kit sobre o global do ambiente. */
export function kitVoiceDelivery(
  kit: { voiceDelivery?: McVoiceDeliveryOverride | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): McVoiceDelivery {
  return mergeVoiceDelivery(resolveVoiceDelivery(env), kit?.voiceDelivery ?? null);
}

/** Chave estável do perfil para hash/cache (mudar o perfil regenera a fala). */
export function voiceDeliveryKey(delivery: McVoiceDelivery): string {
  return [
    `st${delivery.stability}`,
    `si${delivery.similarityBoost}`,
    `sy${delivery.style}`,
    `sp${delivery.speed}`,
    `b${delivery.speakerBoost ? 1 : 0}`,
  ].join('|');
}
