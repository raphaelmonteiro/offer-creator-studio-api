import {
  TerminalProviderError,
  TransientProviderError,
} from '../../../shared/providers/provider-errors';
import {
  KLING_AVATAR_MODEL,
  KLING_AVATAR_PRO_MODEL,
  MINIMAX_H3_LIPSYNC_MODEL,
} from './mc-pipeline.config';

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
