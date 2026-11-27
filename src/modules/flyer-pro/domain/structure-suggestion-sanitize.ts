import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { categorySections, LOOSE_SECTION_ID } from './structure-suggestion-rules';
import { clipText, discardedEntry, dropEntries, type Staged } from './structure-suggestion-discard';
import { sanitizeCampaign } from './structure-suggestion-sanitize-campaign';
import { sanitizeUnsuggest } from './structure-suggestion-sanitize-unsuggest';
import { sanitizeItemOrders, type SectionItemOrder } from './structure-suggestion-sanitize-items';
import type { StructureAliases } from './structure-suggestion-aliases';
import type {
  DiscardedEntry,
  RawStructureSection,
  RawStructureSuggestion,
  SanitizedSuggestion,
  StructureHeroInput,
  StructureRequest,
  StructureSectionInput,
  SuggestedHero,
  SuggestedSection,
  SuggestedUnsuggest,
} from './structure-suggestion.types';

/** O que o saneamento precisa saber, além da resposta do provedor. */
export interface SanitizeContext {
  request: StructureRequest;
  aliases: StructureAliases;
  /** Ids dos itens do encarte com foto no banco (`imageUrl` preenchido). */
  itemsWithPhoto: ReadonlySet<string>;
  /** `FLYER_PRO_STRUCTURE_AI_MAX_HEROES`. */
  maxHeroes: number;
}

/** Uma seção que a resposta manteve: a página e o motivo brutos, e a ordem dos produtos que ela propôs (ainda por conferir). */
interface KeptSection {
  id: string;
  rawPage: number | null;
  reason: string;
  items: RawStructureSection['items'];
  itemsReason: string;
}

/**
 * S1 a S4: a seção que o pedido não tem sai (`UNKNOWN_SECTION`), o bloco de soltos sai sem entrada, a repetida fica na
 * primeira posição (`DUPLICATED`) e a de categoria que a IA esqueceu vai para o fim, na ordem do pedido.
 */
function sanitizeSections(
  raw: RawStructureSuggestion['sections'],
  context: SanitizeContext,
): Staged<KeptSection> {
  const { sectionByAlias } = context.aliases;
  const kept: KeptSection[] = [];
  const discarded: DiscardedEntry[] = [];
  const seen = new Set<string>();
  for (const section of raw) {
    const id = sectionByAlias.get(section.id);
    if (id === LOOSE_SECTION_ID) continue;
    if (id === undefined) {
      discarded.push(discardedEntry('section', 'UNKNOWN_SECTION'));
    } else if (seen.has(id)) {
      discarded.push(discardedEntry('section', 'DUPLICATED'));
    } else {
      seen.add(id);
      kept.push({
        id,
        rawPage: section.page,
        reason: section.reason,
        items: section.items,
        itemsReason: section.itemsReason,
      });
    }
  }
  for (const section of categorySections(context.request.sections)) {
    if (!seen.has(section.id)) {
      kept.push({ id: section.id, rawPage: null, reason: '', items: null, itemsReason: '' });
    }
  }
  return { kept, discarded };
}

const pinnedPageOf = (sections: readonly StructureSectionInput[], id: string) =>
  sections.find((section) => section.id === id)?.pinnedPage;

const isPageInRange = (page: number, pageCount: number) =>
  Number.isInteger(page) && page >= 1 && page <= pageCount;

/**
 * S5 a S7, por seção: página fora de 1 a `pageCount` vira nula (`PAGE_OUT_OF_RANGE`); seção fixada volta sempre com a
 * página do usuário, e só uma página diferente da fixada gera `USER_PINNED` (nula não gera entrada).
 */
function resolvePage(
  rawPage: number | null,
  pinned: number | undefined,
  pageCount: number,
): { page: number | null; discarded: DiscardedEntry[] } {
  const discarded: DiscardedEntry[] = [];
  let page = rawPage ?? null;
  if (page !== null && !isPageInRange(page, pageCount)) {
    discarded.push(discardedEntry('page', 'PAGE_OUT_OF_RANGE'));
    page = null;
  }
  if (pinned === undefined) return { page, discarded };
  if (page !== null && page !== pinned) discarded.push(discardedEntry('page', 'USER_PINNED'));
  return { page: pinned, discarded };
}

function sanitizePages(
  kept: readonly KeptSection[],
  orders: ReadonlyMap<string, SectionItemOrder>,
  context: SanitizeContext,
): Staged<SuggestedSection> {
  const sections: SuggestedSection[] = [];
  const discarded: DiscardedEntry[] = [];
  for (const section of kept) {
    const pinned = pinnedPageOf(context.request.sections, section.id);
    const resolved = resolvePage(section.rawPage, pinned, context.request.pageCount);
    discarded.push(...resolved.discarded);
    sections.push({
      id: section.id,
      page: resolved.page,
      reason: clipText(section.reason, FLYER_PRO_LIMITS.structureReasonMaxLength),
      ...orders.get(section.id),
    });
  }
  return { kept: sections, discarded };
}

const isSameHero = (a: Pick<StructureHeroInput, 'itemId' | 'size'>, b: StructureHeroInput) =>
  a.itemId === b.itemId && a.size === b.size;

/**
 * S8 a S12, nesta ordem: item que não é do pedido (`UNKNOWN_ITEM`), repetido (`DUPLICATED`), sem foto
 * (`HERO_WITHOUT_PHOTO`), que o usuário já tem no mesmo tamanho (`HERO_ALREADY_SET`) ou em outro (`HERO_USER_SET`: o
 * destaque do usuário não muda) e, dos que sobram, os que passam do teto (`HERO_LIMIT`, um por cortado). O destaque que o
 * motor já mostra (`suggestedHeroes`) não tem barreira: no mesmo tamanho ou em outro, passa.
 */
function sanitizeHeroes(
  raw: RawStructureSuggestion['heroes'],
  context: SanitizeContext,
): Staged<SuggestedHero> {
  const { itemByAlias } = context.aliases;
  const known: Array<SuggestedHero | null> = raw.map((hero) => {
    const itemId = itemByAlias.get(hero.item);
    return itemId === undefined
      ? null
      : {
          itemId,
          size: hero.size,
          reason: clipText(hero.reason, FLYER_PRO_LIMITS.structureReasonMaxLength),
        };
  });
  const unknown = known.filter((hero) => hero === null).length;
  let stage: Staged<SuggestedHero> = {
    kept: known.filter((hero): hero is SuggestedHero => hero !== null),
    discarded: Array.from({ length: unknown }, () => discardedEntry('hero', 'UNKNOWN_ITEM')),
  };
  stage = dropEntries(
    stage,
    { kind: 'hero', code: 'DUPLICATED' },
    (hero, index, all) => all.findIndex((other) => other.itemId === hero.itemId) !== index,
  );
  stage = dropEntries(
    stage,
    { kind: 'hero', code: 'HERO_WITHOUT_PHOTO' },
    (hero) => !context.itemsWithPhoto.has(hero.itemId),
  );
  stage = dropEntries(stage, { kind: 'hero', code: 'HERO_ALREADY_SET' }, (hero) =>
    context.request.heroes.some((current) => isSameHero(hero, current)),
  );
  stage = dropEntries(stage, { kind: 'hero', code: 'HERO_USER_SET' }, (hero) =>
    context.request.heroes.some((current) => current.itemId === hero.itemId),
  );
  return dropEntries(
    stage,
    { kind: 'hero', code: 'HERO_LIMIT' },
    (_hero, index) => index >= context.maxHeroes,
  );
}

/** A página que a seção já tem sozinha: a fixada ou, não fixada, a única em que está. */
function currentPageOf(input: StructureSectionInput): number | undefined {
  if (input.pinnedPage !== undefined) return input.pinnedPage;
  return input.pages.length === 1 ? input.pages[0] : undefined;
}

/**
 * S14: sem mudança quando a ordem das seções de categoria é a do pedido, nenhum destaque, ordem de produtos nem sugerido
 * a desfazer sobrou e toda seção vem com página nula ou com a página em que já está. A campanha lida não conta.
 */
function isUnchanged(
  sections: readonly SuggestedSection[],
  heroes: readonly SuggestedHero[],
  unsuggest: readonly SuggestedUnsuggest[],
  request: StructureRequest,
): boolean {
  const asked = categorySections(request.sections);
  if (sections.length !== asked.length || heroes.length > 0 || unsuggest.length > 0) return false;
  if (sections.some((section) => section.itemIds !== null)) return false;
  if (sections.some((section, index) => section.id !== asked[index].id)) return false;
  return sections.every(
    (section, index) => section.page === null || section.page === currentPageOf(asked[index]),
  );
}

/** A resposta do provedor depois das três barreiras do servidor: ids reais, intervalos presos e textos cortados. */
export function sanitizeSuggestion(
  raw: RawStructureSuggestion,
  context: SanitizeContext,
): SanitizedSuggestion {
  const sections = sanitizeSections(raw.sections, context);
  const orders = sanitizeItemOrders(sections.kept, context.aliases);
  const pages = sanitizePages(sections.kept, orders.byId, context);
  const heroes = sanitizeHeroes(raw.heroes, context);
  const unsuggest = sanitizeUnsuggest(raw.unsuggest, heroes.kept, context);
  return {
    summary: clipText(raw.summary, FLYER_PRO_LIMITS.structureSummaryMaxLength),
    campaign: sanitizeCampaign(raw.campaign),
    sections: pages.kept,
    heroes: heroes.kept,
    unsuggest: unsuggest.kept,
    discarded: [
      ...sections.discarded,
      ...pages.discarded,
      ...orders.discarded,
      ...heroes.discarded,
      ...unsuggest.discarded,
    ],
    noChange: isUnchanged(pages.kept, heroes.kept, unsuggest.kept, context.request),
  };
}
