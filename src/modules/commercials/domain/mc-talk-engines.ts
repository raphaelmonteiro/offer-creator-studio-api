import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import { McKitIdentityMode } from './mc-kit-identity';
import {
  KLING_AVATAR_MODEL,
  KLING_AVATAR_PRO_MODEL,
  MC_TALK_ENGINE_KEYS,
  McTalkEngine,
  McTalkEngineKey,
  mcTalkEngines,
  mcUsdPerSecondForModel,
  MINIMAX_H3_LIPSYNC_MODEL,
  talkEngineFor,
  talkFallbackEngineKey,
} from './mc-pipeline.config';
import { McProjectTier } from './mc-types';

/**
 * Adapters de SUBMIT dos motores de fala (change video-formatos-personagem,
 * design D2) — funções PURAS que montam o input de cada endpoint do fal a
 * partir dos mesmos três ingredientes (tile de fala, áudio, prompt curto).
 * O processor escolhe o motor (`talkEngineFor`) e envia pelo FalQueueClient;
 * poll/ingest são os mesmos de qualquer submit assíncrono.
 *
 * Famílias conhecidas:
 * - kling_avatar: `fal-ai/kling-video/ai-avatar/v2/{standard,pro}` —
 *   `{ image_url, audio_url, prompt? }` (mesmo schema do standard já validado).
 * - minimax_h3: `minimax/h3-max/lip-sync/image-to-video` —
 *   `{ image_url, audio_url, prompt?, resolution? }` (resolução só quando o
 *   chamador pede; o default do provider é o 768p tarifado em D2).
 * - omnihuman: `fal-ai/bytedance/omnihuman/v1.5` (tarefa 7.1, candidato
 *   premium do bake-off) — `{ image_url, audio_url, prompt?, resolution }`
 *   com `resolution` SEMPRE explícita (`1080p` por padrão: o premium entrega
 *   1080p nativo, D2/7.2). Sem máscara. Limite de áudio por chamada do fal:
 *   ≤ 30 s a 1080p e ≤ 60 s a 720p (`talkEngineMaxAudioS`); o `maxChunkS`
 *   configurado (30) já bloqueia a aprovação de uma fala maior.
 * - desconhecida: forma mínima `{ image_url, audio_url, prompt? }` — o fal
 *   rejeita com 4xx se faltar algo, antes de cobrar.
 */
export type McTalkEngineFamily = 'kling_avatar' | 'minimax_h3' | 'omnihuman' | 'unknown';

/** OmniHuman 1.5 no fal (ByteDance) — candidato premium do bake-off 7.3. */
export const OMNIHUMAN_V15_MODEL = 'fal-ai/bytedance/omnihuman/v1.5';

/** Resoluções aceitas pelo OmniHuman 1.5 (enum do schema do fal). */
export const OMNIHUMAN_RESOLUTIONS = ['720p', '1080p'] as const;
export type McOmniHumanResolution = (typeof OMNIHUMAN_RESOLUTIONS)[number];

/** Default do adapter: 1080p nativo (premium, D2). */
export const OMNIHUMAN_DEFAULT_RESOLUTION: McOmniHumanResolution = '1080p';

/** Áudio máximo por chamada do OmniHuman 1.5 (docs do fal): 30 s a 1080p, 60 s a 720p. */
export const OMNIHUMAN_MAX_AUDIO_S: Readonly<Record<McOmniHumanResolution, number>> = {
  '1080p': 30,
  '720p': 60,
};

export function talkEngineFamily(model: string): McTalkEngineFamily {
  if (model === KLING_AVATAR_MODEL || model === KLING_AVATAR_PRO_MODEL) return 'kling_avatar';
  if (model.startsWith('fal-ai/kling-video/ai-avatar/')) return 'kling_avatar';
  if (model === MINIMAX_H3_LIPSYNC_MODEL || model.includes('h3-max/lip-sync')) return 'minimax_h3';
  if (model === OMNIHUMAN_V15_MODEL || model.startsWith('fal-ai/bytedance/omnihuman/')) {
    return 'omnihuman';
  }
  return 'unknown';
}

/** `'1080P'`/`' 720p '` → enum do OmniHuman; qualquer outra coisa (ex.: `768P` do H3) → default 1080p. */
export function omnihumanResolution(value: string | null | undefined): McOmniHumanResolution {
  const text = (value ?? '').trim().toLowerCase();
  return (OMNIHUMAN_RESOLUTIONS as readonly string[]).includes(text)
    ? (text as McOmniHumanResolution)
    : OMNIHUMAN_DEFAULT_RESOLUTION;
}

/**
 * Limite DOCUMENTADO de áudio por chamada do modelo (s), na resolução que o
 * adapter vai pedir; `null` = o fornecedor não documenta limite (vale só o
 * `maxChunkS` da config). Hoje só o OmniHuman tem limite publicado.
 */
export function talkEngineMaxAudioS(model: string, resolution?: string | null): number | null {
  if (talkEngineFamily(model) === 'omnihuman') {
    return OMNIHUMAN_MAX_AUDIO_S[omnihumanResolution(resolution)];
  }
  return null;
}

/**
 * Guarda do submit (defesa em profundidade além do bloqueio da aprovação por
 * `maxChunkS`): fala medida acima do limite documentado do modelo vira erro de
 * VALIDAÇÃO terminal ANTES do submit — o fal recusaria depois de enfileirar e
 * o pipeline nunca corta palavras nem acelera o áudio (D7). Duração
 * desconhecida passa (o fornecedor decide).
 */
export function assertTalkAudioWithinEngineLimit(
  model: string,
  audioDurationMs: number | null | undefined,
  resolution?: string | null,
): void {
  const limitS = talkEngineMaxAudioS(model, resolution);
  if (limitS == null || audioDurationMs == null || !Number.isFinite(audioDurationMs)) return;
  const measuredS = audioDurationMs / 1000;
  if (measuredS > limitS) {
    throw new TerminalProviderError(
      `Fala de ${measuredS.toFixed(1)}s excede o limite de ${limitS}s por chamada de ${model}`,
      'audio_too_long',
    );
  }
}

export interface TalkSubmitIngredients {
  /** Data URI (ou URL https) do tile de fala já recolorido. */
  imageUrl: string;
  /** Data URI (ou URL https) do áudio da fala (TTS original). */
  audioUrl: string;
  /** Prompt curto de movimento (`buildTalkPrompt`); vazio = sem prompt. */
  prompt?: string | null;
  /**
   * minimax_h3: resolução pedida ao provider (ex.: '768P'); ausente = default
   * do provider. omnihuman: '720p' | '1080p'; ausente/ inválida = 1080p.
   */
  resolution?: string | null;
}

/** Input do endpoint do fal para o modelo — nunca leva arte de fundo, preço, nome ou logo. */
export function buildTalkSubmitInput(
  model: string,
  input: TalkSubmitIngredients,
): Record<string, unknown> {
  const prompt = input.prompt?.trim();
  const base: Record<string, unknown> = {
    image_url: input.imageUrl,
    audio_url: input.audioUrl,
    ...(prompt ? { prompt } : {}),
  };
  const family = talkEngineFamily(model);
  if (family === 'minimax_h3' && input.resolution?.trim()) {
    base.resolution = input.resolution.trim();
  }
  if (family === 'omnihuman') base.resolution = omnihumanResolution(input.resolution);
  return base;
}

/**
 * Erro de DISPONIBILIDADE do motor (D2: único caso em que o motor de logo cai
 * no motor do tier): rede/5xx/429 (transiente, já re-tentado pelo provider) ou
 * 404/410/501/503 terminais (modelo fora do ar ou descontinuado). Recusa de
 * conteúdo, input inválido e reprovação de inspeção NUNCA contam.
 */
export function isTalkEngineAvailabilityError(err: unknown): boolean {
  if (err instanceof TransientProviderError) return true;
  if (err instanceof TerminalProviderError) {
    if (err.code === 'content_policy') return false;
    return /HTTP (404|410|501|503)\b/.test(err.message);
  }
  return false;
}

// ───────────────── motor escolhido × motor efetivo (snapshot do step) ─────────────────

/** Motor escolhido para o step: config do tier/origem + a chave que o identificou. */
export type McTalkEngineChoice = McTalkEngine & { key: McTalkEngineKey };

/** Motor que de fato recebeu o submit; `fallbackFrom` = modelo escolhido quando houve fallback. */
export type McTalkEffectiveEngine = McTalkEngineChoice & { fallbackFrom?: string };

/** Forma (possivelmente parcial) do motor gravado no snapshot pelo materializer ou por uma execução anterior. */
export type McTalkEngineSnapshot = Partial<McTalkEngine> & { key?: string | null };

export function isTalkEngineKey(value: unknown): value is McTalkEngineKey {
  return typeof value === 'string' && (MC_TALK_ENGINE_KEYS as readonly string[]).includes(value);
}

/**
 * Motor ESCOLHIDO do step: o do snapshot prevalece (o hash assinou aquele
 * modelo), completado pela config quando veio parcial — tarifa pelo modelo
 * (`mcUsdPerSecondForModel`) e `maxChunkS` da chave, nunca `0` gravado como
 * tarifa. Sem snapshot (ou snapshot inválido), a regra D2 (`talkEngineFor`).
 */
export function resolveTalkEngine(
  snapshotEngine: McTalkEngineSnapshot | null | undefined,
  input: {
    tier: McProjectTier | null | undefined;
    identityMode: McKitIdentityMode | null | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): McTalkEngineChoice {
  const model = snapshotEngine?.model?.trim();
  const key = snapshotEngine?.key;
  if (!model || !isTalkEngineKey(key)) return talkEngineFor(input, env);
  const configured = mcTalkEngines(env)[key];
  return {
    key,
    model,
    usdPerSecond:
      snapshotEngine?.usdPerSecond ?? mcUsdPerSecondForModel(model, env) ?? configured.usdPerSecond,
    maxChunkS: snapshotEngine?.maxChunkS ?? configured.maxChunkS,
  };
}

/**
 * Motor de FALLBACK por indisponibilidade (D2): só o motor de logo cai no
 * motor do tier; o efetivo carrega `fallbackFrom` = modelo escolhido, para
 * que `engine` (planejado) e `effectiveEngine` (submetido) fiquem ligados no
 * snapshot. `null` quando o escolhido não tem fallback.
 */
export function talkFallbackEngine(
  chosen: McTalkEngineChoice,
  tier: McProjectTier | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): McTalkEffectiveEngine | null {
  const key = talkFallbackEngineKey(chosen.key, tier);
  if (!key) return null;
  return { key, ...mcTalkEngines(env)[key], fallbackFrom: chosen.model };
}

/**
 * Registro do par no snapshot do step: `engine` = planejado (o que o hash
 * assinou), `effectiveEngine` = o que foi submetido. Invariante: sem fallback
 * os dois são iguais e `fallbackFrom` NÃO existe (um `effectiveEngine` velho
 * de execução anterior nunca sobrevive); com fallback,
 * `effectiveEngine.fallbackFrom === engine.model`.
 */
export function talkEngineSnapshot(
  chosen: McTalkEngineChoice,
  effective: McTalkEffectiveEngine | null = null,
): { engine: McTalkEngineChoice; effectiveEngine: McTalkEffectiveEngine } {
  const engine: McTalkEngineChoice = {
    key: chosen.key,
    model: chosen.model,
    usdPerSecond: chosen.usdPerSecond,
    maxChunkS: chosen.maxChunkS,
  };
  if (!effective || effective.model === chosen.model)
    return { engine, effectiveEngine: { ...engine } };
  return {
    engine,
    effectiveEngine: {
      key: effective.key,
      model: effective.model,
      usdPerSecond: effective.usdPerSecond,
      maxChunkS: effective.maxChunkS,
      fallbackFrom: effective.fallbackFrom ?? chosen.model,
    },
  };
}

// ───────────────────────── 1080p nativo no premium (7.2) ─────────────────────────

/** Lado maior mínimo (px) do clipe premium antes da composição (spec "Tier premium"). */
export const MC_PREMIUM_MIN_LONG_SIDE_PX = 1080;

/**
 * A garantia de 1080 px vale para o tier premium, EXCETO `logo_as_is` (D2: o
 * logo usa o motor de logo em qualquer tier e a garantia não se aplica).
 */
export function premiumResolutionApplies(input: {
  tier: McProjectTier | string | null | undefined;
  identityMode: McKitIdentityMode | string | null | undefined;
}): boolean {
  return input.tier === 'premium' && input.identityMode !== 'logo_as_is';
}

/** Lado maior ≥ 1080 px; dimensões desconhecidas não comprovam a garantia (false). */
export function premiumResolutionOk(
  width: number | null | undefined,
  height: number | null | undefined,
): boolean {
  if (!width || !height || width <= 0 || height <= 0) return false;
  return Math.max(width, height) >= MC_PREMIUM_MIN_LONG_SIDE_PX;
}
