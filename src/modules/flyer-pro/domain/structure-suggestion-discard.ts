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

/**
 * Tira da etapa o que `isRejected` recusa e registra uma entrada `kind`/`code` por coisa tirada, depois das que a etapa já
 * trazia.
 */
export function dropEntries<T>(
  stage: Staged<T>,
  rule: { kind: DiscardedKind; code: DiscardedCode },
  isRejected: (entry: T, index: number, all: T[]) => boolean,
): Staged<T> {
  const kept: T[] = [];
  const discarded = [...stage.discarded];
  stage.kept.forEach((entry, index, all) => {
    if (isRejected(entry, index, all)) discarded.push(discardedEntry(rule.kind, rule.code));
    else kept.push(entry);
  });
  return { kept, discarded };
}
