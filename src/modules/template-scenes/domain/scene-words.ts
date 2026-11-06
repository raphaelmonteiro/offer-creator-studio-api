import { fold } from '../../../shared/text/fold';

/** Palavras de ligação que não provam que o cliente falou do assunto. */
export const FUNCTION_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'no',
  'na',
  'nos',
  'nas',
  'um',
  'uma',
  'uns',
  'umas',
  'ao',
  'aos',
  'em',
  'com',
  'por',
  'para',
  'pra',
  'pro',
  'que',
  'se',
  'ou',
  'e',
  'o',
  'a',
  'os',
  'as',
]);

/** Palavras que carregam o assunto do texto (sem as de ligação), sem acento. */
export const significantWords = (text: string): string[] =>
  fold(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !FUNCTION_WORDS.has(word));

/** Mesma palavra inteira, com ou sem plural: "rio" não é "cenário", "sol" não é "girassol" (R8). */
export const sameWholeWord = (a: string, b: string): boolean =>
  a === b || `${a}s` === b || `${b}s` === a;

/** O texto cita alguma palavra do assunto de `subject`, por palavra inteira? */
export function mentionsWords(subject: string, text: string): boolean {
  const words = significantWords(text);
  return significantWords(subject).some((word) =>
    words.some((other) => sameWholeWord(word, other)),
  );
}
