import { HttpException, HttpStatus } from '@nestjs/common';
import { GEMINI_IMAGE_REQUEST_TIMEOUT_MS } from '../../../shared/providers/gemini-image.provider';
import {
  PROVIDER_RETRY_AFTER_MAX_S,
  PROVIDER_RETRY_ATTEMPTS,
} from '../../../shared/providers/provider-errors';
import { QUEUES, QueueName } from '../../../shared/queue/animation-queue.service';
import { KIT_CANDIDATES_MAX, KIT_REFERENCE_SLOT_COUNT } from './kit-prompts';
import { McKitIdentityMode } from './mc-kit-identity';
import { MC_PROJECT_FORMATS, McProjectFormat, McProjectTier, McStepType } from './mc-types';

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
 * Expiração: filas leves (llm/tts/submit/poll) 120s; mc.image 300s para o
 * keyframe (geração de imagem com retry passa fácil de 2 min); ingest 300s;
 * ffmpeg 600s. O expireInSeconds do pg-boss vale por PUBLISH, então filas
 * compartilhadas (mc.image: kit + keyframe) convivem — os jobs do KIT usam
 * `mcKitReferencesExpireS`/`mcKitCandidatesExpireS`, calculados abaixo.
 */
export const MC_QUEUE_CONCURRENCY: Partial<Record<QueueName, number>> = {
  [QUEUES.MC_LLM]: 2,
  [QUEUES.MC_IMAGE]: 4,
  [QUEUES.MC_TTS]: 4,
  [QUEUES.MC_SUBMIT]: 8,
  [QUEUES.MC_POLL]: 10,
  [QUEUES.MC_INGEST]: 2,
  [QUEUES.MC_FFMPEG]: 1,
  /** Render Remotion do F2 (tarefa 6.5): um navegador headless por vez (CPU da VM). */
  [QUEUES.MC_RENDER]: 1,
};

export const MC_QUEUE_EXPIRE_S: Partial<Record<QueueName, number>> = {
  [QUEUES.MC_LLM]: 120,
  [QUEUES.MC_IMAGE]: 300,
  [QUEUES.MC_TTS]: 120,
  [QUEUES.MC_SUBMIT]: 120,
  [QUEUES.MC_POLL]: 120,
  [QUEUES.MC_INGEST]: 300,
  [QUEUES.MC_FFMPEG]: 600,
  /** Render do F2: ~4 min por 30 s de vídeo na concorrência 1 (benchmark local) — teto de 15 min. */
  [QUEUES.MC_RENDER]: 900,
};

// ───────────────────────── expiração dos jobs do kit ─────────────────────────

/**
 * Timeout de UMA chamada da descrição canônica (gpt-4o visão, `max_tokens`
 * 600): responde em 5 a 15 s; 60 s cobre a cauda sem segurar o job.
 */
export const KIT_CANONICAL_DESC_TIMEOUT_MS = 60_000;

/** Folga dos jobs do kit sobre a soma dos timeouts (leitura de imagens, disco, banco). */
export const MC_KIT_JOB_EXPIRE_MARGIN_S = 120;

/**
 * Pior caso de UMA chamada de imagem do kit: o timeout uma vez (o timeout da
 * imagem é terminal — `retryOnTimeout: false` — porque a requisição abortada
 * pode ter sido gerada e cobrada) mais as esperas entre as tentativas
 * transitórias (429/5xx, cada uma até `PROVIDER_RETRY_AFTER_MAX_S`).
 * Premissa: 429/5xx chegam rápido; um 5xx tardio, perto do timeout, seguido
 * de nova tentativa passa do cálculo — esse caso residual é coberto pela
 * idempotência dos processors (a re-entrega no mesmo worker espera a execução
 * em curso; o slot/linha já pago é pulado).
 */
function kitImageCallWorstMs(imageTimeoutMs: number): number {
  return imageTimeoutMs + (PROVIDER_RETRY_ATTEMPTS - 1) * PROVIDER_RETRY_AFTER_MAX_S * 1000;
}

/**
 * Expiração do job de referências do kit (tarefa 2.6), acima do pior caso:
 * descrição canônica com TODAS as tentativas no timeout (timeout de rede da
 * OpenAI é transitório) e as esperas entre elas — 3 × 60 s + 2 × 60 s — mais
 * 4 referências × (120 s + 2 × 60 s) e a folga = 1380 s.
 * Antes eram 300 s: 4 imagens de até 120 s passavam da expiração, o pg-boss
 * re-entregava o job (retryLimit 3) com o kit ainda em `generating` e as
 * referências eram pagas de novo. Além da expiração, a geração é idempotente
 * por slot (McKitProcessor: claim em memória que faz a re-entrega esperar a
 * execução em curso + referência gravada ao nascer e pulada na re-entrega).
 */
export function mcKitReferencesExpireS(
  slots: number = KIT_REFERENCE_SLOT_COUNT,
  imageTimeoutMs: number = GEMINI_IMAGE_REQUEST_TIMEOUT_MS,
  descTimeoutMs: number = KIT_CANONICAL_DESC_TIMEOUT_MS,
): number {
  const descWorstMs =
    PROVIDER_RETRY_ATTEMPTS * descTimeoutMs +
    (PROVIDER_RETRY_ATTEMPTS - 1) * PROVIDER_RETRY_AFTER_MAX_S * 1000;
  return (
    Math.ceil((descWorstMs + slots * kitImageCallWorstMs(imageTimeoutMs)) / 1000) +
    MC_KIT_JOB_EXPIRE_MARGIN_S
  );
}

/**
 * Expiração da rodada de candidatos (até 6 imagens em sequência), no mesmo
 * pior caso por imagem: 6 × (120 s + 2 × 60 s) + folga = 1560 s. Antes eram
 * 600 s, abaixo de 6 imagens no timeout; a rodada já era idempotente por
 * linha (claim em memória + CAS `assetId IS NULL`).
 */
export function mcKitCandidatesExpireS(
  candidates: number = KIT_CANDIDATES_MAX,
  imageTimeoutMs: number = GEMINI_IMAGE_REQUEST_TIMEOUT_MS,
): number {
  return (
    Math.ceil((candidates * kitImageCallWorstMs(imageTimeoutMs)) / 1000) +
    MC_KIT_JOB_EXPIRE_MARGIN_S
  );
}

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
  [McStepType.SCENE_COMPOSE]: QUEUES.MC_FFMPEG,
  /** Clipe falado a partir do tile: submit assíncrono no fal (mc.submit → mc.poll → mc.ingest). */
  [McStepType.TALK]: QUEUES.MC_SUBMIT,
  /** Steps de projeto dos formatos novos (D6): composição e finalização no ffmpeg (gate ResourceGuard). */
  [McStepType.COMPOSE_FFMPEG]: QUEUES.MC_FFMPEG,
  [McStepType.FINALIZE]: QUEUES.MC_FFMPEG,
  /** Render Remotion do F2 (tarefa 6.5): fila própria com navegador, concorrência 1. */
  [McStepType.RENDER_REMOTION]: QUEUES.MC_RENDER,
  /** Quadro parado da peça de ofertas (6.1): mesmo navegador do render, mesma fila. */
  [McStepType.RENDER_STILL]: QUEUES.MC_RENDER,
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

/**
 * US$/s do step, por tipo (lipsync = Avatar; video = motor de ação; talk =
 * motor econômico). Fallback da telemetria quando o modelo do step não é
 * reconhecido — o caminho principal é `mcUsdPerSecondForModel`.
 */
export function mcUsdPerSecond(stepType: McStepType): number {
  if (stepType === McStepType.VIDEO) return KLING_ACTION_USD_PER_S;
  if (stepType === McStepType.TALK) return mcTalkEngines().economico.usdPerSecond;
  return KLING_AVATAR_USD_PER_S;
}

// ───────────────────────── motores de fala por tier/origem ─────────────────────────

/**
 * Motor de fala (change video-formatos-personagem, design D2): modelo no fal,
 * tarifa em US$/s de saída e máximo de segundos de áudio por chamada
 * (`maxChunkS` — uma fala cujo TTS medido passa disso bloqueia a aprovação
 * com SPEECH_SENTENCE_TOO_LONG, nunca é cortada nem acelerada, D7).
 */
export interface McTalkEngine {
  model: string;
  usdPerSecond: number;
  maxChunkS: number;
}

/** Chaves de configuração dos motores: por tier (econômico/premium) e o motor de logo. */
export const MC_TALK_ENGINE_KEYS = ['economico', 'premium', 'logo'] as const;
export type McTalkEngineKey = (typeof MC_TALK_ENGINE_KEYS)[number];

export type McTalkEngines = Record<McTalkEngineKey, McTalkEngine>;

/** Modelos de referência (fal) — defaults do `.env.example`, bake-offs 3.9/7.3 podem trocar por config. */
export const KLING_AVATAR_PRO_MODEL = 'fal-ai/kling-video/ai-avatar/v2/pro';
export const MINIMAX_H3_LIPSYNC_MODEL = 'minimax/h3-max/lip-sync/image-to-video';

/** Defaults quando `MC_TALK_ENGINE_*` está vazio (mesmos valores do .env.example). */
export const MC_TALK_ENGINE_DEFAULTS: McTalkEngines = {
  economico: { model: KLING_AVATAR_MODEL, usdPerSecond: KLING_AVATAR_USD_PER_S, maxChunkS: 15 },
  premium: { model: KLING_AVATAR_PRO_MODEL, usdPerSecond: 0.115, maxChunkS: 15 },
  logo: { model: MINIMAX_H3_LIPSYNC_MODEL, usdPerSecond: 0.08, maxChunkS: 15 },
};

const MC_TALK_ENGINE_ENV: Record<McTalkEngineKey, string> = {
  economico: 'MC_TALK_ENGINE_ECONOMICO',
  premium: 'MC_TALK_ENGINE_PREMIUM',
  logo: 'MC_TALK_ENGINE_LOGO',
};

/**
 * `modelo|usdPorSegundo|maxChunkS` → motor tipado. Vazio = default; mal
 * formado é erro de configuração (modelo em branco, tarifa negativa ou NaN,
 * maxChunkS ≤ 0) — nunca silenciar uma tarifa errada na telemetria.
 */
export function parseTalkEngine(
  raw: string | undefined,
  fallback: McTalkEngine,
  label = 'MC_TALK_ENGINE',
): McTalkEngine {
  const text = (raw ?? '').trim();
  if (!text) return { ...fallback };
  const [modelRaw, usdRaw, maxRaw] = text.split('|').map((t) => t.trim());
  const model = modelRaw ?? '';
  if (!model) throw new Error(`${label}: modelo em branco em "${text}"`);
  const usdPerSecond = usdRaw ? Number(usdRaw) : fallback.usdPerSecond;
  if (!Number.isFinite(usdPerSecond) || usdPerSecond < 0) {
    throw new Error(`${label}: tarifa inválida "${usdRaw}" (US$/s, número ≥ 0)`);
  }
  const maxChunkS = maxRaw ? Number(maxRaw) : fallback.maxChunkS;
  if (!Number.isFinite(maxChunkS) || maxChunkS <= 0) {
    throw new Error(`${label}: maxChunkS inválido "${maxRaw}" (segundos > 0)`);
  }
  return { model, usdPerSecond, maxChunkS };
}

/** Os três motores configurados (lidos do env a cada chamada: barato e testável). */
export function mcTalkEngines(env: NodeJS.ProcessEnv = process.env): McTalkEngines {
  return {
    economico: parseTalkEngine(
      env[MC_TALK_ENGINE_ENV.economico],
      MC_TALK_ENGINE_DEFAULTS.economico,
      MC_TALK_ENGINE_ENV.economico,
    ),
    premium: parseTalkEngine(
      env[MC_TALK_ENGINE_ENV.premium],
      MC_TALK_ENGINE_DEFAULTS.premium,
      MC_TALK_ENGINE_ENV.premium,
    ),
    logo: parseTalkEngine(
      env[MC_TALK_ENGINE_ENV.logo],
      MC_TALK_ENGINE_DEFAULTS.logo,
      MC_TALK_ENGINE_ENV.logo,
    ),
  };
}

/**
 * Chave do motor pela regra D2: kit `logo_as_is` usa o motor de LOGO em
 * qualquer tier (até o bake-off provar que o premium articula logos); os
 * demais usam o motor do tier. O motor do TIER é também o fallback quando o
 * motor de logo responde erro de disponibilidade (`talkFallbackEngineKey`).
 */
export function talkEngineKeyFor(input: {
  tier: McProjectTier | null | undefined;
  identityMode: McKitIdentityMode | null | undefined;
}): McTalkEngineKey {
  if (input.identityMode === 'logo_as_is') return 'logo';
  return input.tier === 'premium' ? 'premium' : 'economico';
}

export function talkEngineFor(
  input: {
    tier: McProjectTier | null | undefined;
    identityMode: McKitIdentityMode | null | undefined;
  },
  env: NodeJS.ProcessEnv = process.env,
): McTalkEngine & { key: McTalkEngineKey } {
  const key = talkEngineKeyFor(input);
  return { key, ...mcTalkEngines(env)[key] };
}

/** Motor de fallback por indisponibilidade: só existe para o motor de logo (→ motor do tier). */
export function talkFallbackEngineKey(
  key: McTalkEngineKey,
  tier: McProjectTier | null | undefined,
): McTalkEngineKey | null {
  if (key !== 'logo') return null;
  return tier === 'premium' ? 'premium' : 'economico';
}

/**
 * Tarifa (US$/s) de um MODELO (D2: substitui a tarifa por tipo de step na
 * telemetria do ingest): motores configurados primeiro, depois os modelos
 * fixos do pipeline (Avatar standard, ação Kling v3). `null` = desconhecido —
 * o chamador cai na tarifa por tipo de step e registra.
 */
export function mcUsdPerSecondForModel(
  model: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!model) return null;
  const engines = mcTalkEngines(env);
  for (const key of MC_TALK_ENGINE_KEYS) {
    if (engines[key].model === model) return engines[key].usdPerSecond;
  }
  if (model === KLING_AVATAR_MODEL) return KLING_AVATAR_USD_PER_S;
  if (model === KLING_ACTION_MODEL) return KLING_ACTION_USD_PER_S;
  return null;
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

/**
 * Admissão por formato (change video-formatos-personagem, design D13):
 * `MC_FORMATS` é uma lista separada por vírgula dos formatos NOVOS admitidos
 * (`talking_art`, `offer_carousel`). Vazio = nenhum formato novo. O formato
 * `scenes` (F3, v1/v2) SEMPRE passa — ele é governado só por MC_ENABLED e
 * MC_PIPELINE_V2. Token desconhecido é erro de configuração: o módulo chama
 * `parseMcFormats` no boot para falhar cedo, nunca silenciar.
 */
export const MC_FORMATS_ALWAYS_ENABLED: readonly McProjectFormat[] = ['scenes'];

export function parseMcFormats(env: NodeJS.ProcessEnv = process.env): McProjectFormat[] {
  const tokens = (env.MC_FORMATS ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const unknown = tokens.filter((t) => !(MC_PROJECT_FORMATS as readonly string[]).includes(t));
  if (unknown.length > 0) {
    throw new Error(
      `MC_FORMATS: formato desconhecido "${unknown.join('", "')}" ` +
        `(aceitos: ${MC_PROJECT_FORMATS.join(', ')})`,
    );
  }
  return Array.from(new Set(tokens)) as McProjectFormat[];
}

export function isFormatEnabled(
  format: McProjectFormat,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (MC_FORMATS_ALWAYS_ENABLED.includes(format)) return true;
  return parseMcFormats(env).includes(format);
}

/**
 * Formatos novos exigem o executor v2 para TODOS os projetos (design D6:
 * "`MC_FORMATS` não vazio exige `MC_PIPELINE_V2=all`"): F1/F2 gravam
 * `pipelineVersion = 2` explicitamente, sem passar pela coorte. Com a flag em
 * `off`/`cohort`, a admissão recusa com 422 PIPELINE_V2_REQUIRED antes de
 * qualquer escrita. `scenes` nunca é afetado (segue a coorte).
 */
export function isPipelineV2RequiredSatisfied(
  format: McProjectFormat,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (format === 'scenes') return true;
  return (env.MC_PIPELINE_V2 ?? 'off').toLowerCase() === 'all';
}

export function assertPipelineV2ForFormat(
  format: McProjectFormat,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isPipelineV2RequiredSatisfied(format, env)) return;
  throw new HttpException(
    {
      code: 'PIPELINE_V2_REQUIRED',
      message:
        `O formato de vídeo "${format}" exige o executor v2 para todos os projetos ` +
        '(MC_PIPELINE_V2=all)',
      details: { format, pipelineV2: env.MC_PIPELINE_V2 ?? 'off' },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

/** 422 FORMAT_NOT_ENABLED antes de qualquer gasto (criação, ponte e duplicação). */
export function assertFormatEnabled(
  format: McProjectFormat,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isFormatEnabled(format, env)) return;
  throw new HttpException(
    {
      code: 'FORMAT_NOT_ENABLED',
      message: `O formato de vídeo "${format}" não está habilitado neste ambiente`,
      // só o formato pedido: a lista completa de MC_FORMATS é configuração do operador
      details: { format },
    },
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}
