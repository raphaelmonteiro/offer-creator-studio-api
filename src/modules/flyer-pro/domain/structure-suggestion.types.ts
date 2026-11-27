/**
 * Tipos da sugestão de estrutura (N19): o retrato que a tela envia, a resposta bruta do provedor (com apelidos), a
 * proposta saneada e o que a rota devolve. Só tipos, sem regra.
 */

export const STRUCTURE_HERO_SIZES = ['2x1', '2x2'] as const;
export type StructureHeroSize = (typeof STRUCTURE_HERO_SIZES)[number];

export interface StructurePageInput {
  page: number;
  capacityCells: number;
  usedCells: number;
  header: boolean;
  footer: boolean;
}

export interface StructureSectionInput {
  /** `cat:<categoria>` ou `loose` (o bloco de produtos soltos, sempre o último). */
  id: string;
  itemIds: string[];
  cells: number;
  pages: number[];
  pinnedPage?: number;
  quota?: number;
}

export interface StructureHeroInput {
  itemId: string;
  size: StructureHeroSize;
}

/** Um card que a folha mostra como destaque sugerido pelo motor (não escolhido pelo usuário), com a página dele. */
export interface StructureSuggestedHeroInput extends StructureHeroInput {
  page: number;
}

/** O corpo do pedido, já na forma validada pelo DTO. */
export interface StructureRequest {
  stateDigest: string;
  pageCount: number;
  level: 1 | 2 | 3;
  unplaced?: number;
  pages: StructurePageInput[];
  sections: StructureSectionInput[];
  heroes: StructureHeroInput[];
  /** Os sugeridos do motor (a IA pode desfazê-los); ausente vale `[]`, para o front de antes. */
  suggestedHeroes?: StructureSuggestedHeroInput[];
}

export type StructureIssueCode =
  | 'PAGES_MISMATCH'
  | 'TOO_FEW_SECTIONS'
  | 'LOOSE_NOT_LAST'
  | 'SECTION_DUPLICATED'
  | 'SECTION_UNKNOWN'
  | 'ITEM_DUPLICATED';

export interface StructureIssue {
  field: string;
  code: StructureIssueCode;
}

export type DiscardedKind = 'section' | 'page' | 'itemOrder' | 'hero';

export type DiscardedCode =
  | 'UNKNOWN_SECTION'
  | 'DUPLICATED'
  | 'PAGE_OUT_OF_RANGE'
  | 'USER_PINNED'
  | 'UNKNOWN_ITEM'
  | 'HERO_WITHOUT_PHOTO'
  | 'ITEMS_MISMATCH'
  | 'HERO_ALREADY_SET'
  | 'HERO_LIMIT';

/** O que o saneamento tirou: uma entrada por coisa tirada, só com o tipo e o código. */
export interface DiscardedEntry {
  kind: DiscardedKind;
  code: DiscardedCode;
}

export const STRUCTURE_CAMPAIGN_KINDS = ['category', 'discount', 'none'] as const;
export type StructureCampaignKind = (typeof STRUCTURE_CAMPAIGN_KINDS)[number];

/** Uma seção da resposta do provedor: a página, o motivo e a ordem dos produtos (`items`, apelidos; `null` mantém). */
export interface RawStructureSection {
  id: string;
  page: number | null;
  reason: string;
  items: string[] | null;
  itemsReason: string;
}

/** A resposta do provedor, com apelidos (`s1`, `p01`): nada dela vale antes do saneamento. */
export interface RawStructureSuggestion {
  summary: string;
  campaign: { kind: StructureCampaignKind; label: string };
  sections: RawStructureSection[];
  heroes: Array<{ item: string; size: StructureHeroSize; reason: string }>;
  unsuggest: Array<{ item: string; reason: string }>;
}

export interface SuggestedSection {
  /** `cat:<categoria>`: o id real, nunca o apelido. */
  id: string;
  page: number | null;
  reason: string;
  /** Os itens da seção que são do encarte, na ordem proposta (ids reais), ou `null` para manter a ordem de hoje. */
  itemIds: string[] | null;
  /** Até 160 caracteres; `''` quando não há ordem. */
  itemsReason: string;
}

export interface SuggestedHero {
  itemId: string;
  size: StructureHeroSize;
  reason: string;
}

/** A proposta depois do saneamento, com ids reais. */
export interface SanitizedSuggestion {
  summary: string;
  sections: SuggestedSection[];
  heroes: SuggestedHero[];
  discarded: DiscardedEntry[];
  noChange: boolean;
}

/** O item como as consultas do serviço o devolvem: só o que a sugestão lê do banco (nunca vem do pedido). */
export interface StructureItemRow {
  id: string;
  name: string;
  price: Record<string, unknown>;
  unit: string;
  category: string | null;
  imageUrl: string | null;
}

/** Quantos itens, seções e encartes anteriores do cliente o provedor viu. */
export interface StructureBasedOn {
  items: number;
  sections: number;
  clientFlyers: number;
}

/** A resposta 200 da rota: a proposta saneada com o que a tela precisa. Tokens e custo ficam só no log. */
export interface StructureSuggestionView extends SanitizedSuggestion {
  suggestionId: string;
  stateDigest: string;
  source: 'ai' | 'mock';
  model: string;
  promptVersion: number;
  basedOn: StructureBasedOn;
}
