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
 *   `{ image_url, audio_url, resolution? }` (schema público do fal, lido em
 *   13/10/2026: SEM campo de prompt — o prompt de movimento não é enviado;
 *   resolução só quando o chamador pede, o default do provider é o 768p
 *   tarifado em D2). Áudio de 5 s a 15 min por chamada (`talkEngineMinAudioS`):
 *   fala mais curta vai com silêncio no fim até o mínimo + 150 ms de folga
 *   (`planTalkAudioPadding`, decisão do desenvolvedor de 13/10/2026) e o
 *   ingest apara o clipe à fala.
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

/** Áudio mínimo por chamada do MiniMax H3 Max Lip Sync (docs do fal: "at least 5 seconds"). */
export const MINIMAX_H3_MIN_AUDIO_S = 5;

/**
 * Folga (ms) acima do mínimo do motor no silêncio do submit: completa-se a fala
 * medida abaixo de `mínimo + folga` até `mínimo + folga`. Motivo: a duração da
 * fala é a do CONTÊINER (ffprobe `format.duration`), que num MP3 com cabeçalho
 * Info/LAME soma o atraso do encoder e o arredondamento do último quadro — 30 a
 * 70 ms ACIMA do áudio que um decodificador entrega (medido no ffmpeg 6.1.2 do
 * worker: 4,97 s decodificados → 5016 ms no probe; TTS reais da ElevenLabs
 * 10,000 s → 10,031 s e 10,048 s → 10,116 s). Sem a folga, uma fala de ~4,97 s
 * reais ia sem silêncio e o fal recusaria pelo mínimo; e o áudio completado
 * decodificaria em exatamente 5,000 s, sem margem para arredondamento do lado
 * do fornecedor. Com 150 ms: o áudio enviado decodifica em ≥ 5,15 s quando
 * completado e em ≥ ~5,07 s quando vai como está. Custo extra: 0,15 s por fala
 * curta (US$ 0,012 na tarifa do H3). Mudar o valor = bump de
 * `MC_BUILDER_VERSIONS_V2.talk` depois que houver clipes completados gerados.
 */
export const MC_TALK_AUDIO_PAD_MARGIN_MS = 150;

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
 * Mínimo DOCUMENTADO de áudio por chamada do modelo (s); `null` = sem mínimo
 * publicado. Hoje só o MiniMax H3 Max Lip Sync (5 s).
 */
export function talkEngineMinAudioS(model: string): number | null {
  return talkEngineFamily(model) === 'minimax_h3' ? MINIMAX_H3_MIN_AUDIO_S : null;
}

/**
 * Guarda do submit (defesa em profundidade além do bloqueio da aprovação por
 * `maxChunkS`): o áudio que VAI ao motor (o TTS, ou o TTS completado com
 * silêncio por `planTalkAudioPadding`) fora dos limites documentados do modelo
 * vira erro de VALIDAÇÃO terminal ANTES do submit — o fal recusaria depois de
 * enfileirar e o pipeline nunca corta palavras nem acelera o áudio (D7).
 * Acima do máximo → `audio_too_long`; abaixo do mínimo → `audio_too_short`
 * (com o silêncio do submit, só um áudio NÃO completado chega aqui abaixo do
 * mínimo). Duração desconhecida passa aqui; num motor com mínimo ela já foi
 * barrada antes por `assertTalkSpeechMeasuredForEngine`.
 */
export function assertTalkAudioWithinEngineLimit(
  model: string,
  audioDurationMs: number | null | undefined,
  resolution?: string | null,
): void {
  if (audioDurationMs == null || !Number.isFinite(audioDurationMs)) return;
  const measuredS = audioDurationMs / 1000;
  const limitS = talkEngineMaxAudioS(model, resolution);
  if (limitS != null && measuredS > limitS) {
    throw new TerminalProviderError(
      `Fala de ${measuredS.toFixed(1)}s excede o limite de ${limitS}s por chamada de ${model}`,
      'audio_too_long',
    );
  }
  const minS = talkEngineMinAudioS(model);
  if (minS != null && measuredS < minS) {
    throw new TerminalProviderError(
      `Fala de ${measuredS.toFixed(1)}s abaixo do mínimo de ${minS}s por chamada de ${model}`,
      'audio_too_short',
    );
  }
}

// ─────────────── fala curta: silêncio no fim até o mínimo do motor ───────────────

/**
 * Registro do áudio COMPLETADO COM SILÊNCIO enviado ao motor (decisão do
 * desenvolvedor de 13/10/2026, "completar com silêncio"): gravado no snapshot
 * do step (`inputSnapshot.audioPadding`) e no metadata do clipe para que a
 * revisão e o relatório de custo expliquem por que um clipe de 2 s custou 5 s.
 */
export interface McTalkAudioPadding {
  /** Modelo que exige o mínimo (o motor que recebeu o submit). */
  engineModel: string;
  /** Mínimo documentado do motor (s). */
  minS: number;
  /** Duração medida da fala (TTS original, ms). */
  speechMs: number;
  /** Duração do áudio enviado (fala + silêncio no fim, ms) — base da cobrança do fornecedor. */
  submittedMs: number;
}

/**
 * Alvo (ms) do silêncio do submit para o motor: o mínimo documentado mais a
 * folga da medida do MP3 (`MC_TALK_AUDIO_PAD_MARGIN_MS`; H3: 5150 ms). É ao
 * mesmo tempo o limiar (fala medida abaixo dele é completada) e a duração do
 * áudio completado. `null` = motor sem mínimo publicado.
 */
export function talkAudioPadTargetMs(model: string): number | null {
  const minS = talkEngineMinAudioS(model);
  return minS == null ? null : minS * 1000 + MC_TALK_AUDIO_PAD_MARGIN_MS;
}

/**
 * Plano do silêncio do submit: motor com mínimo documentado (H3: 5 s) e fala
 * MEDIDA abaixo do alvo (`talkAudioPadTargetMs`: mínimo + folga de 150 ms da
 * medida do MP3) → o áudio enviado é o TTS seguido de silêncio até o alvo
 * (`submittedMs` = alvo; o submit regrava com a medida do arquivo completado).
 * `null` = enviar o TTS como está (motor sem mínimo, fala que já alcança o
 * alvo ou duração desconhecida — esta última o submit nunca deixa chegar a um
 * motor com mínimo: `assertTalkSpeechMeasuredForEngine`). O asset do TTS nunca
 * é tocado: o ingest apara o clipe à fala e remuxa o TTS original (D7).
 */
export function planTalkAudioPadding(
  model: string,
  speechMs: number | null | undefined,
): McTalkAudioPadding | null {
  const minS = talkEngineMinAudioS(model);
  const targetMs = talkAudioPadTargetMs(model);
  if (minS == null || targetMs == null || !isMeasuredSpeechMs(speechMs)) return null;
  if (speechMs >= targetMs) return null;
  return { engineModel: model, minS, speechMs: Math.round(speechMs), submittedMs: targetMs };
}

function isMeasuredSpeechMs(speechMs: number | null | undefined): speechMs is number {
  return speechMs != null && Number.isFinite(speechMs) && speechMs > 0;
}

/**
 * Guarda do submit para motor com mínimo documentado (H3): sem a duração MEDIDA
 * da fala não há como decidir o silêncio, e mandar o TTS cru arriscaria a
 * recusa do fal pelo mínimo DEPOIS de enfileirar (step terminal, créditos
 * consumidos e estornados). Vira erro TRANSIENTE antes de qualquer chamada ao
 * fal — o step volta à fila e mede de novo (ex.: ffprobe que estourou o tempo
 * num worker carregado). O submit chama esta guarda FORA do try do fallback:
 * falha local nunca troca o motor de logo pelo do tier. Motor sem mínimo passa.
 */
export function assertTalkSpeechMeasuredForEngine(
  model: string,
  speechMs: number | null | undefined,
): void {
  const minS = talkEngineMinAudioS(model);
  if (minS == null || isMeasuredSpeechMs(speechMs)) return;
  throw new TransientProviderError(
    `Duração da fala desconhecida: ${model} exige ≥ ${minS}s de áudio por chamada e o ` +
      'silêncio do submit depende da medida — submit adiado, nada foi enviado',
  );
}

/**
 * Argumentos do ffmpeg do silêncio do submit: só a trilha de áudio do TTS,
 * `apad=whole_dur` (silêncio no FIM até a duração total pedida) com `-t` de
 * trava, em MP3 CBR 128 kbps — o mesmo `audio/mpeg` do data URI do submit e o
 * formato padrão da ElevenLabs (`mp3_44100_128`). Sem `-ar`/`-ac`: a taxa de
 * amostragem e os canais do TTS são mantidos. Função PURA (o processor executa).
 */
export function buildTalkAudioPadArgs(opts: {
  input: string;
  output: string;
  totalS: number;
}): string[] {
  const total = opts.totalS.toFixed(3);
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    opts.input,
    '-map',
    '0:a:0',
    '-af',
    `apad=whole_dur=${total}`,
    '-t',
    total,
    '-c:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-f',
    'mp3',
    opts.output,
  ];
}

/** Lê `audioPadding` de um snapshot/metadata (forma desconhecida) — inválido vira `null`. */
export function readTalkAudioPadding(value: unknown): McTalkAudioPadding | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const minS = num(v.minS);
  const speechMs = num(v.speechMs);
  const submittedMs = num(v.submittedMs);
  if (minS == null || speechMs == null || submittedMs == null) return null;
  return {
    engineModel: typeof v.engineModel === 'string' ? v.engineModel : '',
    minS,
    speechMs,
    submittedMs,
  };
}

/**
 * Duração COBRADA pelo fornecedor por um clipe `talk` (ms): a do clipe cru
 * devolvido, nunca abaixo do áudio submetido com silêncio (o fornecedor cobra
 * os segundos enviados — max(fala, mínimo + folga) — mesmo que o ingest apare o clipe
 * à fala). Sem silêncio, a do clipe cru (regra anterior).
 */
export function talkBilledDurationMs(
  rawClipMs: number | null | undefined,
  padding: McTalkAudioPadding | null | undefined,
): number | null {
  const raw = rawClipMs != null && Number.isFinite(rawClipMs) ? rawClipMs : null;
  if (!padding) return raw;
  return Math.max(raw ?? 0, padding.submittedMs);
}

export interface TalkSubmitIngredients {
  /** Data URI (ou URL https) do tile de fala já recolorido. */
  imageUrl: string;
  /** Data URI (ou URL https) do áudio da fala (TTS original). */
  audioUrl: string;
  /** Prompt curto de movimento (`buildTalkPrompt`); vazio = sem prompt. Não vai ao H3 (sem o campo). */
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
  const family = talkEngineFamily(model);
  // H3 Max Lip Sync não tem campo de prompt no schema do fal: só tile + áudio.
  const prompt = family === 'minimax_h3' ? null : input.prompt?.trim();
  const base: Record<string, unknown> = {
    image_url: input.imageUrl,
    audio_url: input.audioUrl,
    ...(prompt ? { prompt } : {}),
  };
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
