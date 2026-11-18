import type { StructureSectionInput } from './structure-suggestion.types';

/**
 * Apelidos que vão ao provedor no lugar dos ids: seções `s1`, `s2`… (com o bloco de soltos) e itens `p01`, `p02`… na ordem
 * do pedido. O modelo nunca vê um UUID e só apelido volta valendo (um id real devolvido por ele é desconhecido).
 */
export interface StructureAliases {
  sectionByAlias: ReadonlyMap<string, string>;
  aliasBySection: ReadonlyMap<string, string>;
  itemByAlias: ReadonlyMap<string, string>;
  aliasByItem: ReadonlyMap<string, string>;
}

const itemAliasOf = (position: number) => `p${String(position).padStart(2, '0')}`;

/**
 * `realItemIds` são os ids do pedido que são itens do encarte: só eles ganham apelido (ids estranhos são ignorados e não
 * deixam buraco na numeração). Item repetido em duas seções mantém o apelido da primeira aparição.
 */
export function buildAliases(
  sections: readonly StructureSectionInput[],
  realItemIds: ReadonlySet<string>,
): StructureAliases {
  const sectionByAlias = new Map<string, string>();
  const aliasBySection = new Map<string, string>();
  const itemByAlias = new Map<string, string>();
  const aliasByItem = new Map<string, string>();
  sections.forEach((section, index) => {
    sectionByAlias.set(`s${index + 1}`, section.id);
    aliasBySection.set(section.id, `s${index + 1}`);
  });
  for (const section of sections) {
    for (const itemId of section.itemIds) {
      if (!realItemIds.has(itemId) || aliasByItem.has(itemId)) continue;
      const alias = itemAliasOf(aliasByItem.size + 1);
      aliasByItem.set(itemId, alias);
      itemByAlias.set(alias, itemId);
    }
  }
  return { sectionByAlias, aliasBySection, itemByAlias, aliasByItem };
}
