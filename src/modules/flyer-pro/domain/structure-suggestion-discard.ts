import type { DiscardedCode, DiscardedEntry, DiscardedKind } from './structure-suggestion.types';

/** O que cada etapa do saneamento devolve: o que ficou e uma entrada de `discarded` por coisa tirada. */
export interface Staged<T> {
  kept: T[];
  discarded: DiscardedEntry[];
}

/** Uma entrada de `discarded`: só o tipo e o código. */
export const discardedEntry = (kind: DiscardedKind, code: DiscardedCode): DiscardedEntry => ({
  kind,
  code,
});

/** Aparado e cortado em `max` caracteres (pontos de código), sem reticências; vazio ou ausente vale `''`. */
export function clipText(text: string | null | undefined, max: number): string {
  return Array.from((text ?? '').trim())
    .slice(0, max)
    .join('');
}
