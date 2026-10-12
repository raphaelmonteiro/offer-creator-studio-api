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
 * - desconhecida: forma mínima `{ image_url, audio_url, prompt? }` — o fal
 *   rejeita com 4xx se faltar algo, antes de cobrar.
 */
export type McTalkEngineFamily = 'kling_avatar' | 'minimax_h3' | 'unknown';

export function talkEngineFamily(model: string): McTalkEngineFamily {
  if (model === KLING_AVATAR_MODEL || model === KLING_AVATAR_PRO_MODEL) return 'kling_avatar';
  if (model.startsWith('fal-ai/kling-video/ai-avatar/')) return 'kling_avatar';
  if (model === MINIMAX_H3_LIPSYNC_MODEL || model.includes('h3-max/lip-sync')) return 'minimax_h3';
  return 'unknown';
}

export interface TalkSubmitIngredients {
  /** Data URI (ou URL https) do tile de fala já recolorido. */
  imageUrl: string;
  /** Data URI (ou URL https) do áudio da fala (TTS original). */
  audioUrl: string;
  /** Prompt curto de movimento (`buildTalkPrompt`); vazio = sem prompt. */
  prompt?: string | null;
  /** Só minimax_h3: resolução pedida ao provider (ex.: '768P'); ausente = default do provider. */
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
  if (talkEngineFamily(model) === 'minimax_h3' && input.resolution?.trim()) {
    base.resolution = input.resolution.trim();
  }
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
