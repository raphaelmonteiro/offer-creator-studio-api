/**
 * Legendas queimadas a partir dos timestamps do TTS (plano-comerciais §5.4:
 * "legendas queimadas usam os timestamps do TTS, sem ASR") — domínio PURO.
 *
 * A ElevenLabs devolve alinhamento por CARACTERE
 * (`/v1/text-to-speech/{voice}/with-timestamps`); aqui os caracteres viram
 * palavras, as palavras viram linhas de até ~38 caracteres quebradas em
 * pontuação/espaço, e cada linha vira uma "cue" com início/fim absolutos no
 * vídeo final (offset da cena somado).
 */

/** Alinhamento por caractere, como vem da ElevenLabs (campos originais). */
export interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Trecho de texto com janela de tempo — base de legendas E de selos. */
export interface TextCue {
  text: string;
  startS: number;
  endS: number;
}

/** Largura máxima de uma linha de legenda (contrato v1-B1: ~38 chars). */
export const CAPTION_MAX_CHARS = 38;

/** Duração mínima de uma cue na tela (evita flash ilegível). */
export const CAPTION_MIN_DURATION_S = 0.6;

/** Pontuação que FECHA a linha (fim de frase). */
const HARD_BREAK = /[.!?…]$/;
/** Pontuação que fecha a linha quando ela já está razoavelmente cheia. */
const SOFT_BREAK = /[,;:]$/;

interface TimedWord {
  text: string;
  startS: number;
  endS: number;
}

function isValidAlignment(alignment: ElevenLabsAlignment | null | undefined): boolean {
  return (
    !!alignment &&
    Array.isArray(alignment.characters) &&
    Array.isArray(alignment.character_start_times_seconds) &&
    Array.isArray(alignment.character_end_times_seconds) &&
    alignment.characters.length > 0 &&
    alignment.characters.length === alignment.character_start_times_seconds.length &&
    alignment.characters.length === alignment.character_end_times_seconds.length
  );
}

/** Caracteres → palavras com janela de tempo (espaços/quebras separam). */
export function alignmentToWords(alignment: ElevenLabsAlignment): TimedWord[] {
  const words: TimedWord[] = [];
  let current: TimedWord | null = null;
  for (let i = 0; i < alignment.characters.length; i += 1) {
    const char = alignment.characters[i];
    const start = Number(alignment.character_start_times_seconds[i]);
    const end = Number(alignment.character_end_times_seconds[i]);
    if (/\s/.test(char)) {
      if (current) words.push(current);
      current = null;
      continue;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!current) current = { text: char, startS: start, endS: end };
    else {
      current.text += char;
      current.endS = Math.max(current.endS, end);
    }
  }
  if (current) words.push(current);
  return words;
}

/**
 * Agrupa o alinhamento em linhas de legenda. `offsetS` desloca as cues para a
 * posição da cena no vídeo final (a montagem concatena as cenas em ordem).
 */
export function buildCaptionCues(
  alignment: ElevenLabsAlignment | null | undefined,
  opts: { offsetS?: number; maxChars?: number; clipDurationS?: number } = {},
): TextCue[] {
  if (!isValidAlignment(alignment)) return [];
  const maxChars = opts.maxChars ?? CAPTION_MAX_CHARS;
  const offsetS = opts.offsetS ?? 0;
  const words = alignmentToWords(alignment as ElevenLabsAlignment);
  const cues: TextCue[] = [];

  let line: TimedWord[] = [];
  const flush = (): void => {
    if (line.length === 0) return;
    const text = line.map((w) => w.text).join(' ');
    const startS = line[0].startS;
    const endS = Math.max(line[line.length - 1].endS, startS + CAPTION_MIN_DURATION_S);
    cues.push({ text, startS, endS });
    line = [];
  };

  for (const word of words) {
    const lineLength = line.reduce((sum, w) => sum + w.text.length + 1, 0);
    if (line.length > 0 && lineLength + word.text.length > maxChars) flush();
    line.push(word);
    if (HARD_BREAK.test(word.text)) {
      flush();
      continue;
    }
    const filled = line.reduce((sum, w) => sum + w.text.length + 1, 0);
    if (SOFT_BREAK.test(word.text) && filled >= maxChars * 0.6) flush();
  }
  flush();

  // Nunca deixar uma cue passar do fim do clipe (a última palavra pode ter o
  // fim estendido pelo mínimo de duração) e aplicar o offset da cena.
  const limit = opts.clipDurationS;
  return cues
    .map((cue) => ({
      text: cue.text,
      startS: Math.max(0, cue.startS) + offsetS,
      endS: (limit != null ? Math.min(cue.endS, limit) : cue.endS) + offsetS,
    }))
    .filter((cue) => cue.endS > cue.startS);
}

/**
 * Alinhamento SINTÉTICO uniforme — usado pelo provider mock (o mp3 mock não
 * tem fala de verdade): distribui os caracteres do texto igualmente ao longo
 * da duração, o que basta para exercitar o pipeline de legendas sem gastar API.
 */
export function syntheticAlignment(text: string, durationS: number): ElevenLabsAlignment {
  const characters = [...text];
  const total = Math.max(0.1, durationS);
  const step = characters.length > 0 ? total / characters.length : total;
  return {
    characters,
    character_start_times_seconds: characters.map((_, i) => Number((i * step).toFixed(3))),
    character_end_times_seconds: characters.map((_, i) => Number(((i + 1) * step).toFixed(3))),
  };
}
