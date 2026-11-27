import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { clipText, dropEntries, type Staged } from './structure-suggestion-discard';
import type { SanitizeContext } from './structure-suggestion-sanitize';
import type {
  RawStructureSuggestion,
  SuggestedHero,
  SuggestedUnsuggest,
} from './structure-suggestion.types';

const unsuggestRule = (
  code: 'UNKNOWN_ITEM' | 'DUPLICATED' | 'NOT_SUGGESTED' | 'CONFLICTS_WITH_HERO',
) => ({
  kind: 'unsuggest' as const,
  code,
});

/**
 * Os sugeridos do motor que a IA propõe desfazer (A-4, A-5), depois do saneamento dos destaques, nesta ordem: apelido
 * desconhecido (`UNKNOWN_ITEM`), repetido, fica a primeira vez (`DUPLICATED`), fora de `suggestedHeroes` do pedido
 * (`NOT_SUGGESTED`) e item que ficou em `heroes` (`CONFLICTS_WITH_HERO`: o destaque vale e o desfazer sai). Uma entrada
 * `unsuggest` em `discarded` por tirado; o motivo é aparado e cortado em 160 caracteres.
 */
export function sanitizeUnsuggest(
  raw: RawStructureSuggestion['unsuggest'],
  keptHeroes: readonly SuggestedHero[],
  context: SanitizeContext,
): Staged<SuggestedUnsuggest> {
  const { itemByAlias } = context.aliases;
  const known = raw.map((entry) => ({ itemId: itemByAlias.get(entry.item), reason: entry.reason }));
  let stage: Staged<SuggestedUnsuggest> = {
    kept: known
      .filter((entry): entry is SuggestedUnsuggest => entry.itemId !== undefined)
      .map(({ itemId, reason }) => ({
        itemId,
        reason: clipText(reason, FLYER_PRO_LIMITS.structureReasonMaxLength),
      })),
    discarded: known
      .filter((entry) => entry.itemId === undefined)
      .map(() => ({ kind: 'unsuggest' as const, code: 'UNKNOWN_ITEM' as const })),
  };
  const suggested = new Set((context.request.suggestedHeroes ?? []).map((hero) => hero.itemId));
  const heroed = new Set(keptHeroes.map((hero) => hero.itemId));
  stage = dropEntries(
    stage,
    unsuggestRule('DUPLICATED'),
    (entry, index, all) => all.findIndex((other) => other.itemId === entry.itemId) !== index,
  );
  stage = dropEntries(
    stage,
    unsuggestRule('NOT_SUGGESTED'),
    (entry) => !suggested.has(entry.itemId),
  );
  return dropEntries(stage, unsuggestRule('CONFLICTS_WITH_HERO'), (entry) =>
    heroed.has(entry.itemId),
  );
}
