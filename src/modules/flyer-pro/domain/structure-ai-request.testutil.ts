import { buildStructureAiRequest, type StructureAiRequest } from './structure-ai-request';
import { buildAliases } from './structure-suggestion-aliases';
import { EXAMPLE_ITEMS, exampleRequest } from './structure-suggestion.testutil';
import type { StructureItemRow, StructureRequest } from './structure-suggestion.types';

/** O pedido ao provedor do encarte de exemplo, com apelidos (só testes); `over` troca o nome, os itens ou o retrato. */
export function exampleAiRequest(
  over: {
    documentName?: string;
    request?: StructureRequest;
    items?: readonly StructureItemRow[];
    maxHeroes?: number;
  } = {},
): StructureAiRequest {
  const request = over.request ?? exampleRequest();
  const items = over.items ?? EXAMPLE_ITEMS;
  return buildStructureAiRequest({
    documentName: over.documentName ?? 'Ofertas da semana 47',
    format: '27x40',
    request,
    aliases: buildAliases(request.sections, new Set(items.map((item) => item.id))),
    items,
    examples: [],
    maxHeroes: over.maxHeroes ?? 12,
  });
}
