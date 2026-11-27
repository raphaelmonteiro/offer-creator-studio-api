import { buildAliases } from './structure-suggestion-aliases';
import type { SanitizeContext } from './structure-suggestion-sanitize';
import { EXAMPLE_ITEMS, exampleRequest } from './structure-suggestion.testutil';
import type {
  RawStructureSection,
  RawStructureSuggestion,
  StructureRequest,
} from './structure-suggestion.types';

/** Ajudantes dos specs do saneamento (só testes): o contexto do exemplo e a resposta bruta do provedor, com apelidos. */

/** O contexto do exemplo: apelidos do retrato, fotos do banco (todos menos o TOMATE) e teto de 12 destaques. */
export function sanitizeContext(
  request: StructureRequest = exampleRequest(),
  over: Partial<SanitizeContext> = {},
): SanitizeContext {
  const real = new Set(EXAMPLE_ITEMS.map((item) => item.id));
  return {
    request,
    aliases: buildAliases(request.sections, real),
    itemsWithPhoto: new Set(EXAMPLE_ITEMS.filter((item) => item.imageUrl).map((item) => item.id)),
    maxHeroes: 12,
    ...over,
  };
}

/** Uma seção da saída do provedor; `order` traz a ordem dos produtos (`items`, apelidos) e o motivo dela. */
export const rawSection = (
  id: string,
  page: number | null = null,
  reason = '',
  order: { items?: string[] | null; itemsReason?: string } = {},
): RawStructureSection => ({
  id,
  page,
  reason,
  items: order.items ?? null,
  itemsReason: order.itemsReason ?? '',
});

export const rawUnsuggest = (item: string, reason = '') => ({ item, reason });

export const rawHero = (item: string, size: '2x1' | '2x2' = '2x1', reason = '') => ({
  item,
  size,
  reason,
});

/** A resposta do provedor com as três seções do exemplo na ordem do pedido, sem destaque; `over` troca campos. */
export const rawSuggestion = (
  over: Partial<RawStructureSuggestion> = {},
): RawStructureSuggestion => ({
  summary: '',
  campaign: { kind: 'none', label: '' },
  sections: [rawSection('s1'), rawSection('s2'), rawSection('s3')],
  heroes: [],
  unsuggest: [],
  ...over,
});

export const sectionIds = (result: { sections: Array<{ id: string }> }) =>
  result.sections.map((entry) => entry.id);

export const discardedCodes = (result: { discarded: Array<{ kind: string; code: string }> }) =>
  result.discarded.map((entry) => `${entry.kind}:${entry.code}`);
