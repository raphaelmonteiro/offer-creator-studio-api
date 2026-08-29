import { QUEUES, QueueName } from '../../../shared/queue/animation-queue.service';
import { McStepType } from './mc-types';

/**
 * Configuração das filas do pipeline de produção (plano-comerciais §6.4):
 * 1 job = 1 step curto. Fonte única de roteamento step → fila, expiração POR
 * FILA e concorrência POR FILA — os services/processors nunca hardcodam esses
 * números (mesmo papel do mc-pricing.config para custos).
 *
 * Concorrências: mc.llm 2 · mc.image 4 · mc.tts 4 · mc.submit 8 ·
 * mc.poll 10 (NUNCA gated) · mc.ingest 2 (gate ResourceGuard) ·
 * mc.ffmpeg 1 (gate ResourceGuard).
 *
 * Expiração: filas leves (llm/tts/submit/poll) 120s; mc.image 300s (geração
 * de imagem com retry passa fácil de 2 min — mesmo teto que o kit usa);
 * ingest 300s; ffmpeg 600s. O expireInSeconds do pg-boss vale por PUBLISH,
 * então filas compartilhadas (mc.image: kit + keyframe) convivem.
 */
export const MC_QUEUE_CONCURRENCY: Partial<Record<QueueName, number>> = {
  [QUEUES.MC_LLM]: 2,
  [QUEUES.MC_IMAGE]: 4,
  [QUEUES.MC_TTS]: 4,
  [QUEUES.MC_SUBMIT]: 8,
  [QUEUES.MC_POLL]: 10,
  [QUEUES.MC_INGEST]: 2,
  [QUEUES.MC_FFMPEG]: 1,
};

export const MC_QUEUE_EXPIRE_S: Partial<Record<QueueName, number>> = {
  [QUEUES.MC_LLM]: 120,
  [QUEUES.MC_IMAGE]: 300,
  [QUEUES.MC_TTS]: 120,
  [QUEUES.MC_SUBMIT]: 120,
  [QUEUES.MC_POLL]: 120,
  [QUEUES.MC_INGEST]: 300,
  [QUEUES.MC_FFMPEG]: 600,
};

/**
 * Fila de cada tipo de step. `video` e `lipsync` são submits assíncronos
 * (mc.submit → mc.poll → mc.ingest); keyframe reusa a fila mc.image existente
 * (o consumer despacha kit × keyframe pelo payload).
 */
export const MC_STEP_QUEUE: Record<McStepType, QueueName> = {
  [McStepType.SCRIPT]: QUEUES.MC_LLM,
  [McStepType.KEYFRAME]: QUEUES.MC_IMAGE,
  [McStepType.TTS]: QUEUES.MC_TTS,
  [McStepType.VIDEO]: QUEUES.MC_SUBMIT,
  [McStepType.LIPSYNC]: QUEUES.MC_SUBMIT,
  [McStepType.ASSEMBLY]: QUEUES.MC_FFMPEG,
};

/**
 * Kling AI Avatar v2 standard via fal — motor audio-driven das cenas faladas
 * validado no PoC (plano §5.3): input `{ image_url, audio_url }`, data URIs
 * aceitos com teto de ~3,3MB de binário por data URI (o base64 infla ~33% e o
 * limite prático do endpoint fica em ~4,4MB de payload por campo).
 */
export const KLING_AVATAR_MODEL = 'fal-ai/kling-video/ai-avatar/v2/standard';

/** Custo de tabela do provider (US$/s do Kling AI Avatar v2, plano §5.1) — telemetria de margem. */
export const KLING_AVATAR_USD_PER_S = 0.0562;

/**
 * MOTOR DE AÇÃO das cenas SEM fala (v1-B1) — Kling v3 standard image-to-video
 * via fal, decisão fechada no PoC (plano §1.3 changelog v1.3: "ação = Kling v3
 * standard"; preservou estilo em 3/3 arquétipos e resolveu prop-swap).
 * Input do endpoint: `{ prompt, negative_prompt, image_url, duration }` com
 * `duration` string '5' ou '10' e image_url aceitando data URI (mesmo teto de
 * ~3,3MB do Avatar).
 */
export const KLING_ACTION_MODEL = 'fal-ai/kling-video/v3/standard/image-to-video';

/** US$/s do Kling v3 standard (PoC: 10s = US$0,84) — telemetria de margem. */
export const KLING_ACTION_USD_PER_S = 0.084;

/**
 * Negative prompt padrão do PoC (scripts/poc-comerciais/jobs/*.json) — é o que
 * segurou identidade/estilo nas 7/7 gerações utilizáveis da rodada 1.
 */
export const KLING_ACTION_NEGATIVE_PROMPT =
  'different character, changed colors, distorted logo, extra fingers, extra limbs, ' +
  'morphing, melting, flicker, text, watermark, background change, camera movement';

/** Durações aceitas pelo endpoint do Kling v3 (string, por contrato do fal). */
export const KLING_ACTION_DURATIONS = ['5', '10'] as const;
export type KlingActionDuration = (typeof KLING_ACTION_DURATIONS)[number];

/** Duração do clipe mais próxima da cena (empate em 7,5s resolve para 5s — mais barato). */
export function klingActionDuration(durationS: number): KlingActionDuration {
  return durationS > 7.5 ? '10' : '5';
}

/** US$/s do step, por tipo (lipsync = Avatar; video = motor de ação). */
export function mcUsdPerSecond(stepType: McStepType): number {
  return stepType === McStepType.VIDEO ? KLING_ACTION_USD_PER_S : KLING_AVATAR_USD_PER_S;
}

/** Teto de binário por data URI aceito no submit (lição do PoC — plano §5.3). */
export const MC_DATA_URI_MAX_BYTES = Math.floor(3.3 * 1024 * 1024);

/** Backoff do polling (plano §6.4): 15/30/60s com cap no último valor. */
export const MC_POLL_BACKOFF_S = [15, 30, 60] as const;

/** Timeout duro do provider_wait de vídeo/lipsync (plano §6.4: teto vídeo 15 min). */
export const MC_POLL_TIMEOUT_MS = 15 * 60 * 1000;

/** Cap de download do ingest (plano §6.8: anti-SSRF endurecido). */
export const MC_INGEST_MAX_BYTES = 200 * 1024 * 1024;

/** Delay do primeiro poll após o submit (o provider nunca conclui antes disso). */
export const MC_FIRST_POLL_DELAY_S = 15;

export function mcQueueForStep(type: McStepType): QueueName {
  return MC_STEP_QUEUE[type];
}

export function mcExpireForQueue(queue: QueueName): number {
  return MC_QUEUE_EXPIRE_S[queue] ?? 120;
}

export function mcPollBackoffS(attempt: number): number {
  const index = Math.max(0, Math.min(attempt - 1, MC_POLL_BACKOFF_S.length - 1));
  return MC_POLL_BACKOFF_S[index];
}

/**
 * Allowlist de hosts do ingest (plano §6.8): APENAS os domínios de entrega da
 * fal — `fal.media`, `*.fal.media` e `*.fal.run` — e https obrigatório.
 * Validação por HOSTNAME parseado (nunca substring: `fal.media.evil.com` não
 * passa). Qualquer outra origem é bloqueada antes de qualquer byte baixado.
 */
export function isAllowedFalVideoUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'fal.media' || host.endsWith('.fal.media') || host.endsWith('.fal.run');
}
