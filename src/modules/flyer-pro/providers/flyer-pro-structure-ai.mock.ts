import { fold } from '../../../shared/text/fold';
import type {
  StructureAiItem,
  StructureAiRequest,
  StructureAiResult,
  StructureAiSection,
} from '../domain/structure-ai-request';
import type {
  RawStructureSection,
  RawStructureSuggestion,
} from '../domain/structure-suggestion.types';
import {
  FlyerProStructureAiPort,
  StructureAiCallOptions,
  StructureAiFailure,
} from './flyer-pro-structure-ai.port';

/** A ordem fixa do simulado (as 11 categorias do módulo, de Carnes a Bazar). */
const MOCK_ORDER = [
  'Carnes',
  'Hortifruti',
  'Bebidas',
  'Mercearia',
  'Frios e Laticinios',
  'Padaria',
  'Congelados',
  'Limpeza',
  'Higiene e Perfumaria',
  'Pet',
  'Bazar',
];

/** A espera do marcador `#ia-lenta`. */
export const MOCK_SLOW_MS = 3000;

const HEROES_FROM_SECTIONS = 2;

interface Markers {
  falha: boolean;
  lenta: boolean;
  igual: boolean;
  naoCabe: boolean;
  semSugeridos: boolean;
  desconto: boolean;
  categoria: boolean;
}

/** Os marcadores do nome do encarte, sem diferença de maiúsculas nem de acento. */
function markersOf(documentName: string): Markers {
  const name = fold(documentName);
  return {
    falha: name.includes('#ia-falha'),
    lenta: name.includes('#ia-lenta'),
    igual: name.includes('#ia-igual'),
    naoCabe: name.includes('#ia-nao-cabe'),
    semSugeridos: name.includes('#ia-sem-sugeridos'),
    desconto: name.includes('#ia-desconto'),
    categoria: name.includes('#ia-categoria'),
  };
}

const rankOf = (section: StructureAiSection): number => {
  const index = MOCK_ORDER.indexOf(section.category ?? '');
  return index === -1 ? MOCK_ORDER.length : index;
};

const categorySections = (request: StructureAiRequest) =>
  request.sections.filter((section) => section.category !== null);

/** Seções de categoria na ordem fixa do simulado (estável para categorias fora da tabela). */
const tableOrder = (request: StructureAiRequest): StructureAiSection[] =>
  [...categorySections(request)].sort((a, b) => rankOf(a) - rankOf(b));

const NO_CAMPAIGN: RawStructureSuggestion['campaign'] = { kind: 'none', label: '' };

/** A ordem atual, sem página, destaque, ordem de produtos, sugerido a desfazer nem campanha (`#ia-igual`). */
function sameOrder(request: StructureAiRequest): RawStructureSuggestion {
  return {
    summary: '[simulado] A estrutura atual já segue as recomendações.',
    campaign: NO_CAMPAIGN,
    sections: categorySections(request).map((section) => ({
      id: section.alias,
      page: null,
      reason: `[simulado] ${section.category} fica onde está.`,
      items: null,
      itemsReason: '',
    })),
    heroes: [],
    unsuggest: [],
  };
}

/** O primeiro item com foto da seção, na ordem do pedido, fora os que `skip` tira (os que o simulado desfaz). */
const firstPhotoItem = (
  request: StructureAiRequest,
  section: StructureAiSection,
  skip: ReadonlySet<string>,
) =>
  request.items.find(
    (item) => item.sectionAlias === section.alias && item.hasPhoto && !skip.has(item.alias),
  );

const isFromTo = (item: StructureAiItem) => item.price.kind === 'from_to';

const sameSequence = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((alias, index) => alias === b[index]);

/**
 * A ordem dos produtos de uma seção (A-10): os de/por primeiro e depois os outros, cada grupo na ordem do pedido. Sem
 * mudança, `items` é nulo e o motivo vazio; com mudança, o motivo diz "[simulado]".
 */
function orderOfItems(
  request: StructureAiRequest,
  section: StructureAiSection,
): Pick<RawStructureSection, 'items' | 'itemsReason'> {
  const own = request.items.filter((item) => item.sectionAlias === section.alias);
  const sorted = [...own.filter(isFromTo), ...own.filter((item) => !isFromTo(item))];
  const aliases = sorted.map((item) => item.alias);
  if (sameSequence(aliases, section.itemAliases)) return { items: null, itemsReason: '' };
  return { items: aliases, itemsReason: '[simulado] De/por primeiro.' };
}

/** Os sugeridos do motor do pedido, na ordem do pedido (`#ia-sem-sugeridos` desfaz todos). */
const suggestedAliases = (request: StructureAiRequest): string[] =>
  request.items.filter((item) => item.suggestedHero !== null).map((item) => item.alias);

/** A campanha simulada: `#ia-desconto` vence `#ia-categoria`; sem nenhum dos dois, nenhuma. */
function campaignOf(markers: Markers): RawStructureSuggestion['campaign'] {
  if (markers.desconto) return { kind: 'discount', label: '[simulado] desconto' };
  if (markers.categoria) return { kind: 'category', label: '[simulado] categoria' };
  return NO_CAMPAIGN;
}

/** A resposta normal: a ordem fixa, a primeira seção na página 1 e 2x1 no primeiro item com foto das duas primeiras. */
function tableSuggestion(request: StructureAiRequest, markers: Markers): RawStructureSuggestion {
  const ordered = tableOrder(request);
  // `#ia-sem-sugeridos` desfaz os sugeridos; o simulado não os propõe como destaque ao mesmo tempo (seria CONFLICTS_WITH_HERO).
  const undone = new Set(markers.semSugeridos ? suggestedAliases(request) : []);
  const heroes = ordered.slice(0, HEROES_FROM_SECTIONS).flatMap((section) => {
    const item = firstPhotoItem(request, section, undone);
    return item
      ? [
          {
            item: item.alias,
            size: '2x1' as const,
            reason: `[simulado] Primeiro produto com foto de ${section.category}.`,
          },
        ]
      : [];
  });
  return {
    summary: '[simulado] Ordem fixa do simulado: Carnes e Hortifruti abrem o encarte.',
    campaign: campaignOf(markers),
    sections: ordered.map((section, index) => ({
      id: section.alias,
      page: index === 0 ? 1 : null,
      reason: `[simulado] ${section.category} na posição ${index + 1}.`,
      ...orderOfItems(request, section),
    })),
    heroes,
    unsuggest: [...undone].map((item) => ({
      item,
      reason: '[simulado] Sugerido do motor desfeito.',
    })),
  };
}

const fillOf = (page: { usedCells: number; capacityCells: number }) =>
  page.capacityCells > 0 ? page.usedCells / page.capacityCells : 0;

/** A maior seção sem página fixada (por `cells`); no empate, a primeira do pedido. */
function biggestFreeSection(request: StructureAiRequest): StructureAiSection | undefined {
  const free = categorySections(request).filter((section) => section.pinnedPage === undefined);
  return free.reduce<StructureAiSection | undefined>(
    (best, section) => (best === undefined || section.cells > best.cells ? section : best),
    undefined,
  );
}

/** A página mais cheia (maior `usedCells / capacityCells`; no empate, a de menor número) em que a seção não está. */
function fullestPageWithout(request: StructureAiRequest, section: StructureAiSection) {
  const candidates = request.pages.filter((page) => !section.pages.includes(page.page));
  return [...candidates].sort((a, b) => fillOf(b) - fillOf(a) || a.page - b.page)[0];
}

/** `#ia-nao-cabe`: fixa a maior seção livre na página mais cheia entre as que ela não ocupa. */
function applyDoesNotFit(
  request: StructureAiRequest,
  suggestion: RawStructureSuggestion,
): RawStructureSuggestion {
  const biggest = biggestFreeSection(request);
  const fullest = biggest && fullestPageWithout(request, biggest);
  if (!biggest || !fullest) return suggestion;
  return {
    ...suggestion,
    sections: suggestion.sections.map((section) =>
      section.id === biggest.alias ? { ...section, page: fullest.page } : section,
    ),
  };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * O provedor simulado na versão 2: sem rede e sem custo, a mesma resposta para o mesmo pedido. Marcadores no nome do encarte
 * mudam a resposta (`#ia-falha` vence `#ia-igual`, que vence os demais; `#ia-lenta` soma a espera a qualquer um;
 * `#ia-nao-cabe`, `#ia-sem-sugeridos`, `#ia-desconto` e `#ia-categoria`, com `#ia-desconto` vencendo `#ia-categoria`, mudam
 * a resposta normal).
 */
export class MockFlyerProStructureAi implements FlyerProStructureAiPort {
  readonly source = 'mock' as const;

  constructor(private readonly sleep: (ms: number) => Promise<void> = defaultSleep) {}

  unavailableReason(): null {
    return null;
  }

  async suggest(
    request: StructureAiRequest,
    _options: StructureAiCallOptions,
  ): Promise<StructureAiResult> {
    const markers = markersOf(request.documentName);
    if (markers.lenta) await this.sleep(MOCK_SLOW_MS);
    if (markers.falha) throw new StructureAiFailure('PROVIDER_ERROR', 'Falha simulada (#ia-falha)');
    if (markers.igual) return { suggestion: sameOrder(request), model: 'mock', usage: null };
    const table = tableSuggestion(request, markers);
    const suggestion = markers.naoCabe ? applyDoesNotFit(request, table) : table;
    return { suggestion, model: 'mock', usage: null };
  }
}
