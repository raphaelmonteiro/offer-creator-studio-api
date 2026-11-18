import {
  ITEM_FIELD_KEYS,
  FlyerProItemEntry,
  ItemDraft,
  ItemFields,
  StoredItem,
} from './flyer-pro-item.types';

/** O que um campo vale num item novo quando o corpo não o traz: nulo, e `false` no selo +18 (PU-31). */
const NEW_ITEM_DEFAULTS: Partial<ItemFields> = { isAlcoholic: false };

/**
 * Mescla o que veio sobre o item gravado: campo ausente não muda, `null` limpa. Item novo parte dos padrões. O nome é
 * gravado aparado (A-10).
 */
export function mergeItem(entry: FlyerProItemEntry, stored: StoredItem | null): ItemFields {
  const merged = {} as Record<string, unknown>;
  for (const key of ITEM_FIELD_KEYS) {
    const sent = entry[key];
    const base = stored ? stored[key] : (NEW_ITEM_DEFAULTS[key] ?? null);
    merged[key] = sent === undefined ? base : sent;
  }
  if (typeof merged.name === 'string') merged.name = merged.name.trim();
  // A coluna do selo +18 não aceita nulo: `null` no corpo vale como desligado.
  if (merged.isAlcoholic === null) merged.isAlcoholic = false;
  return merged as unknown as ItemFields;
}

export function draftOf(
  entry: FlyerProItemEntry,
  stored: StoredItem | null,
  replaceAll: boolean,
): ItemDraft {
  return { entry, stored, merged: mergeItem(entry, stored), replaceAll };
}
