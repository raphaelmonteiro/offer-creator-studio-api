import type { McProjectOptions, McScript } from './mc-types';

/**
 * Configuração da fala contínua (change video-fala-continua, design D2/D4/D15/D16).
 * Funções PURAS sobre o ambiente (lidas a cada chamada, como `mcTalkEngines`).
 *
 * - `MC_TALK_CONTINUOUS`: liga o modo para projetos NOVOS; só a API a lê (congelada no roteiro).
 * - `MC_TALK_CHUNK_MAX_S`: teto (s) de áudio por trecho; vazio = `maxChunkS` do motor.
 * - `MC_TALK_POLL_PER_AUDIO_S`: espera (s) por segundo de áudio no `provider_wait` do trecho.
 */

/** Padrão provisório do teto do trecho (Q1, decisoes.md §2.11): a 3.4 calibra. */
export const MC_TALK_CHUNK_MAX_S_DEFAULT = 10;

/** Espera por segundo de áudio no poll do `talk` de trecho (D15). */
export const MC_TALK_POLL_PER_AUDIO_S_DEFAULT = 150;

/** Piso e teto do timeout do `provider_wait` de um trecho (D15). */
export const MC_TALK_POLL_MIN_MS = 15 * 60 * 1000;
export const MC_TALK_POLL_MAX_MS = 40 * 60 * 1000;

/** Formatos que têm o modo contínuo (D2): peça de ofertas e arte que fala. */
export const MC_TALK_CONTINUOUS_FORMATS = ['talking_art', 'offer_piece'] as const;

export function isTalkContinuousFormat(format: string | null | undefined): boolean {
  return (MC_TALK_CONTINUOUS_FORMATS as readonly string[]).includes(format ?? '');
}

export function isTalkContinuousEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.MC_TALK_CONTINUOUS ?? '').trim().toLowerCase() === 'true';
}

function parsePositive(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} inválida: "${raw}" (esperado número maior que 0)`);
  }
  return value;
}

/**
 * Teto do trecho (s) lido do ambiente. Ausente → padrão provisório (10 s); vazio explícito →
 * `null` (= `maxChunkS` do motor). Valor que não seja número > 0 lança (derruba o boot).
 */
export function talkChunkMaxS(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.MC_TALK_CHUNK_MAX_S;
  if (raw === undefined) return MC_TALK_CHUNK_MAX_S_DEFAULT;
  const text = raw.trim();
  if (text === '') return null;
  return parsePositive('MC_TALK_CHUNK_MAX_S', text);
}

/** Segundos de espera por segundo de áudio; ausente/vazio → 150. Inválido lança. */
export function talkPollPerAudioS(env: NodeJS.ProcessEnv = process.env): number {
  const text = (env.MC_TALK_POLL_PER_AUDIO_S ?? '').trim();
  if (text === '') return MC_TALK_POLL_PER_AUDIO_S_DEFAULT;
  return parsePositive('MC_TALK_POLL_PER_AUDIO_S', text);
}

/** Valida as duas variáveis no boot (falha cedo, nunca silencia). */
export function assertTalkContinuousEnv(env: NodeJS.ProcessEnv = process.env): void {
  talkChunkMaxS(env);
  talkPollPerAudioS(env);
}

/**
 * Timeout do `provider_wait` de um `talk` (ms): `clamp(sentS × MC_TALK_POLL_PER_AUDIO_S, 15 min, 40 min)`.
 * 4,3 s → 15 min (o piso de hoje), 10 s → 25 min, 15 s → 37,5 min. Áudio desconhecido → piso.
 */
export function talkPollTimeoutMs(
  sentMs: number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (sentMs == null || !Number.isFinite(sentMs) || sentMs <= 0) return MC_TALK_POLL_MIN_MS;
  const ms = (sentMs / 1000) * talkPollPerAudioS(env) * 1000;
  return Math.round(Math.min(MC_TALK_POLL_MAX_MS, Math.max(MC_TALK_POLL_MIN_MS, ms)));
}

/** Teto efetivo do trecho (s) por motor, para `GET config` (D2): `min(maxChunkS, MC_TALK_CHUNK_MAX_S ?? maxChunkS)`. */
export function effectiveChunkMaxS(
  engineMaxChunkS: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = talkChunkMaxS(env);
  return configured == null ? engineMaxChunkS : Math.min(engineMaxChunkS, configured);
}

/**
 * Modo de gravação a congelar num projeto NOVO (criação e duplicação, D2/Q5): `'continuous'` quando a
 * flag está ligada e o formato é `talking_art` ou `offer_piece`; `undefined` nos demais casos.
 */
export function talkModeForNewProject(
  format: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 'continuous' | undefined {
  if (!isTalkContinuousEnabled(env)) return undefined;
  return isTalkContinuousFormat(format) ? 'continuous' : undefined;
}

/** Roteiro com o modo da duplicação (Q5): grava `talkMode` quando contínuo, remove quando não. */
export function applyTalkModeToScript(script: McScript, mode: 'continuous' | undefined): McScript {
  const { talkMode: _previous, ...rest } = script;
  return mode ? { ...rest, talkMode: mode } : rest;
}

/** Opções do projeto com o modo da duplicação (Q5), no mesmo padrão do roteiro. */
export function applyTalkModeToOptions(
  options: McProjectOptions,
  mode: 'continuous' | undefined,
): McProjectOptions {
  const { talkMode: _previous, ...rest } = options;
  return mode ? { ...rest, talkMode: mode } : rest;
}
