import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { clipText } from './structure-suggestion-clip-text';
import { discardedEntry } from './structure-suggestion-discard';
import type { StructureAliases } from './structure-suggestion-aliases';
import type { DiscardedEntry } from './structure-suggestion.types';

/** A ordem dos produtos de uma seção: os ids reais na ordem proposta, ou `null` (manter), e o motivo ('' sem ordem). */
export interface SectionItemOrder {
  itemIds: string[] | null;
  itemsReason: string;
}

/** O que a saneamento da ordem lê de uma seção que a resposta manteve. */
export interface RawItemOrder {
  /** O id real da seção (`cat:Carnes`), nunca o apelido. */
  id: string;
  /** Os apelidos na ordem proposta; `null` mantém a ordem do pedido (e a seção esquecida pela IA vem assim). */
  items: string[] | null;
  itemsReason: string;
}

const NO_ORDER: SectionItemOrder = { itemIds: null, itemsReason: '' };

export const sameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((alias, index) => alias === b[index]);

/** Cada apelido dos itens da seção exatamente uma vez: nem falta, nem sobra, nem repete, nem apelido desconhecido. */
function isCompleteOrder(given: readonly string[], expected: readonly string[]): boolean {
  const wanted = new Set(expected);
  return (
    given.length === expected.length &&
    new Set(given).size === given.length &&
    given.every((alias) => wanted.has(alias))
  );
}

/**
 * A ordem dos produtos de uma seção (A-1, A-2): lista inteira ou nada. `items` nulo, ou igual à ordem do pedido, vale
 * `null` sem entrada; lista que não traz cada item da seção uma vez vale `null` com `ITEMS_MISMATCH`. O motivo só fica
 * quando há ordem. O bloco de soltos nunca chega aqui (o saneamento das seções o tira antes, sem entrada).
 */
function sanitizeItemOrder(
  section: RawItemOrder,
  aliases: StructureAliases,
): { order: SectionItemOrder; discarded: DiscardedEntry[] } {
  if (section.items === null) return { order: NO_ORDER, discarded: [] };
  const expected = aliases.itemAliasesBySection.get(section.id) ?? [];
  if (!isCompleteOrder(section.items, expected)) {
    return { order: NO_ORDER, discarded: [discardedEntry('itemOrder', 'ITEMS_MISMATCH')] };
  }
  if (sameSequence(section.items, expected)) return { order: NO_ORDER, discarded: [] };
  return {
    order: {
      itemIds: section.items.map((alias) => aliases.itemByAlias.get(alias)),
      itemsReason: clipText(section.itemsReason, FLYER_PRO_LIMITS.structureReasonMaxLength),
    },
    discarded: [],
  };
}

/** A ordem dos produtos de cada seção que ficou na resposta, por id real, e uma entrada `itemOrder` por ordem descartada. */
export function sanitizeItemOrders(
  kept: readonly RawItemOrder[],
  aliases: StructureAliases,
): { byId: Map<string, SectionItemOrder>; discarded: DiscardedEntry[] } {
  const byId = new Map<string, SectionItemOrder>();
  const discarded: DiscardedEntry[] = [];
  for (const section of kept) {
    const result = sanitizeItemOrder(section, aliases);
    byId.set(section.id, result.order);
    discarded.push(...result.discarded);
  }
  return { byId, discarded };
}
