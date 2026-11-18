import { fold } from '../../../shared/text/fold';
import type {
  StructureAiRequest,
  StructureAiResult,
  StructureAiSection,
} from '../domain/structure-ai-request';
import type { RawStructureSuggestion } from '../domain/structure-suggestion.types';
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
}

/** Os marcadores do nome do encarte, sem diferença de maiúsculas nem de acento. */
function markersOf(documentName: string): Markers {
  const name = fold(documentName);
  return {
    falha: name.includes('#ia-falha'),
    lenta: name.includes('#ia-lenta'),
    igual: name.includes('#ia-igual'),
    naoCabe: name.includes('#ia-nao-cabe'),
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

/** A ordem atual, sem página e sem destaque (`#ia-igual`). */
function sameOrder(request: StructureAiRequest): RawStructureSuggestion {
  return {
    summary: '[simulado] A estrutura atual já segue as recomendações.',
    sections: categorySections(request).map((section) => ({
      id: section.alias,
      page: null,
      reason: `[simulado] ${section.category} fica onde está.`,
    })),
    heroes: [],
  };
}

/** O primeiro item com foto da seção, na ordem do pedido. */
const firstPhotoItem = (request: StructureAiRequest, section: StructureAiSection) =>
  request.items.find((item) => item.sectionAlias === section.alias && item.hasPhoto);

/** A resposta normal: a ordem fixa, a primeira seção na página 1 e 2x1 no primeiro item com foto das duas primeiras. */
function tableSuggestion(request: StructureAiRequest): RawStructureSuggestion {
  const ordered = tableOrder(request);
  const heroes = ordered.slice(0, HEROES_FROM_SECTIONS).flatMap((section) => {
    const item = firstPhotoItem(request, section);
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
    sections: ordered.map((section, index) => ({
      id: section.alias,
      page: index === 0 ? 1 : null,
      reason: `[simulado] ${section.category} na posição ${index + 1}.`,
    })),
    heroes,
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
 * O provedor simulado: sem rede e sem custo, a mesma resposta para o mesmo pedido. Marcadores no nome do encarte mudam a
 * resposta (`#ia-falha` vence `#ia-igual`, que vence `#ia-nao-cabe`; `#ia-lenta` soma a espera a qualquer um).
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
    const table = tableSuggestion(request);
    const suggestion = markers.naoCabe ? applyDoesNotFit(request, table) : table;
    return { suggestion, model: 'mock', usage: null };
  }
}
