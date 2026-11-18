import type { LlmUsage } from '../../ai/openai-llm-pricing';
import type { StructureAliases } from './structure-suggestion-aliases';
import { LOOSE_SECTION_ID } from './structure-suggestion-rules';
import type { StructureExample } from './read-structure-example';
import type {
  RawStructureSuggestion,
  StructureHeroSize,
  StructureItemRow,
  StructurePageInput,
  StructureRequest,
} from './structure-suggestion.types';
import type { FlyerProFormat } from './flyer-pro.types';

/**
 * O que a porta do provedor recebe: o retrato da tela e o que veio do banco, tudo com apelidos (`s1`, `p01`) e sem nenhum
 * UUID. O provedor simulado lê os campos de dados; o real monta a mensagem "DADOS" a partir deles.
 */
export interface StructureAiSection {
  alias: string;
  /** A categoria ("Carnes") ou `null` no bloco de soltos. */
  category: string | null;
  itemAliases: string[];
  cells: number;
  /** Páginas em que a seção está hoje. */
  pages: number[];
  pinnedPage?: number;
  quota?: number;
}

export interface StructureAiItem {
  alias: string;
  sectionAlias: string;
  name: string;
  price: Record<string, unknown>;
  unit: string;
  hasPhoto: boolean;
  /** O destaque que o usuário já tem neste item. */
  hero: StructureHeroSize | null;
}

export interface StructureAiRequest {
  documentName: string;
  format: FlyerProFormat;
  pageCount: number;
  level: number;
  unplaced: number;
  /** Teto de destaques novos (`FLYER_PRO_STRUCTURE_AI_MAX_HEROES`). */
  maxHeroes: number;
  pages: StructurePageInput[];
  sections: StructureAiSection[];
  items: StructureAiItem[];
  examples: StructureExample[];
}

/** A resposta bruta do provedor, o modelo que respondeu e os tokens (só para o log). */
export interface StructureAiResult {
  suggestion: RawStructureSuggestion;
  model: string;
  usage: LlmUsage | null;
}

export interface StructureAiRequestInput {
  documentName: string;
  format: FlyerProFormat;
  request: StructureRequest;
  aliases: StructureAliases;
  /** Os itens do encarte que o pedido cita, lidos do banco. */
  items: readonly StructureItemRow[];
  examples: readonly StructureExample[];
  maxHeroes: number;
}

const categoryOf = (sectionId: string): string | null =>
  sectionId === LOOSE_SECTION_ID ? null : sectionId.slice('cat:'.length);

/** Os apelidos dos itens de cada seção na ordem do pedido, só dos que são do encarte e na primeira aparição. */
function itemAliasesBySection(input: StructureAiRequestInput): Map<string, string[]> {
  const claimed = new Set<string>();
  const bySection = new Map<string, string[]>();
  for (const section of input.request.sections) {
    const aliases: string[] = [];
    for (const itemId of section.itemIds) {
      const alias = input.aliases.aliasByItem.get(itemId);
      if (alias === undefined || claimed.has(itemId)) continue;
      claimed.add(itemId);
      aliases.push(alias);
    }
    bySection.set(section.id, aliases);
  }
  return bySection;
}

/** O pedido ao provedor: seções e itens por apelido, o nome do encarte e os exemplos do cliente. */
export function buildStructureAiRequest(input: StructureAiRequestInput): StructureAiRequest {
  const { request, aliases } = input;
  const bySection = itemAliasesBySection(input);
  const rows = new Map(input.items.map((item) => [item.id, item]));
  const heroOf = new Map(request.heroes.map((hero) => [hero.itemId, hero.size]));
  const sections = request.sections.map(
    (section): StructureAiSection => ({
      alias: aliases.aliasBySection.get(section.id),
      category: categoryOf(section.id),
      itemAliases: bySection.get(section.id) ?? [],
      cells: section.cells,
      pages: section.pages,
      ...(section.pinnedPage !== undefined ? { pinnedPage: section.pinnedPage } : {}),
      ...(section.quota !== undefined ? { quota: section.quota } : {}),
    }),
  );
  const items = sections.flatMap((section) =>
    section.itemAliases.map((alias): StructureAiItem => {
      const id = aliases.itemByAlias.get(alias);
      const row = rows.get(id);
      return {
        alias,
        sectionAlias: section.alias,
        name: row.name,
        price: row.price,
        unit: row.unit,
        hasPhoto: Boolean(row.imageUrl),
        hero: heroOf.get(id) ?? null,
      };
    }),
  );
  return {
    documentName: input.documentName,
    format: input.format,
    pageCount: request.pageCount,
    level: request.level,
    unplaced: request.unplaced ?? 0,
    maxHeroes: input.maxHeroes,
    pages: request.pages,
    sections,
    items,
    examples: [...input.examples],
  };
}
