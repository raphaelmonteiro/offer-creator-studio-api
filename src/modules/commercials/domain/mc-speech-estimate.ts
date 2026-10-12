/**
 * Estimativa de duração da fala (puro, sem Nest): a mesma taxa que o diretor
 * usa para dimensionar falas (15 caracteres/s) e que o TTS mock usa para
 * produzir áudio de duração realista. Vivia em `processors/mc-tts.processor`;
 * mudou-se para o domain porque o diretor F1 (change video-formatos-personagem,
 * D6) divide a narração por frase sob o `maxChunkS` do motor com esta mesma
 * estimativa — o processor reexporta para preservar os imports existentes.
 */

/** Caracteres falados por segundo (herdado da v0; igual a MC_CHARS_PER_SECOND do diretor). */
export const MC_SPEECH_CHARS_PER_SECOND = 15;

/** Teto padrão (s) da duração do TTS mock — `MC_MOCK_TTS_MAX_S` sobrescreve. */
export const MC_MOCK_TTS_MAX_S_DEFAULT = 20;

/** Cap do mock configurável (tarefa 3.6): testar SPEECH_SENTENCE_TOO_LONG sem API. */
export function mockTtsMaxS(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MC_MOCK_TTS_MAX_S);
  return Number.isFinite(raw) && raw > 0 ? raw : MC_MOCK_TTS_MAX_S_DEFAULT;
}

/** Estimativa SEM teto (uma casa decimal, mínimo 1 s) — o que o diretor usa para dividir falas. */
export function estimateSpeechSecondsRaw(text: string): number {
  return Math.max(1, Math.round((text.trim().length / MC_SPEECH_CHARS_PER_SECOND) * 10) / 10);
}

/**
 * Mock v2: a duração acompanha o texto (15 chars/s, mesma taxa do diretor),
 * para que a validação "locução cabe no clipe" e o manifesto exercitem
 * números realistas sem gastar API. Faixa 1–`maxS` (default 20 s).
 */
export function estimateSpeechSeconds(text: string, maxS: number = mockTtsMaxS()): number {
  return Math.min(maxS, estimateSpeechSecondsRaw(text));
}
