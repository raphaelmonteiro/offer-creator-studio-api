import { FLYER_PRO_CATEGORIES } from './flyer-pro-categories';
import { missingFields } from './flyer-pro-presence';
import {
  flyerProBadRequest,
  flyerProMissingFields,
  flyerProStructureStateInvalid,
} from './flyer-pro.errors';
import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import type {
  StructureIssue,
  StructureRequest,
  StructureSectionInput,
} from './structure-suggestion.types';

/** O bloco de produtos soltos: sempre o último e fora da ordem (nunca vai na resposta). */
export const LOOSE_SECTION_ID = 'loose';
const CATEGORY_PREFIX = 'cat:';

const REQUIRED_FIELDS = ['stateDigest', 'pageCount', 'level', 'pages', 'sections', 'heroes'];

/** As seções de categoria do pedido (todas menos o bloco de soltos), na ordem recebida. */
export const categorySections = (sections: readonly StructureSectionInput[]) =>
  sections.filter((section) => section.id !== LOOSE_SECTION_ID);

/**
 * As conferências de forma que o `class-validator` não faz: os obrigatórios à mão (o pipe pula o corpo `{}`) e a soma dos
 * ids de item de todas as seções (400, antes de qualquer leitura do banco).
 */
export function assertStructureBody(body: Partial<StructureRequest>): void {
  const missing = missingFields(body, REQUIRED_FIELDS);
  if (missing.length > 0) throw flyerProMissingFields(missing);
  const total = body.sections.reduce((sum, section) => sum + section.itemIds.length, 0);
  if (total > FLYER_PRO_LIMITS.itemMax) {
    throw flyerProBadRequest(
      `O pedido traz ${total} ids de item; o máximo é ${FLYER_PRO_LIMITS.itemMax}.`,
    );
  }
}

const sectionField = (index: number, name: string) => `sections[${index}].${name}`;

/** As páginas 1 a `pageCount` uma vez cada, e nenhuma seção fixada além de `pageCount`. */
function pageIssues(request: StructureRequest): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const pages = request.pages.map((entry) => entry.page).sort((a, b) => a - b);
  const expected = Array.from({ length: request.pageCount }, (_, index) => index + 1);
  if (pages.join() !== expected.join()) issues.push({ field: 'pages', code: 'PAGES_MISMATCH' });
  request.sections.forEach((section, index) => {
    if (section.pinnedPage !== undefined && section.pinnedPage > request.pageCount) {
      issues.push({ field: sectionField(index, 'pinnedPage'), code: 'PAGES_MISMATCH' });
    }
  });
  return issues;
}

/** Menos de 2 seções de categoria (o bloco de soltos não conta). */
function tooFewIssues(sections: readonly StructureSectionInput[]): StructureIssue[] {
  return categorySections(sections).length < 2
    ? [{ field: 'sections', code: 'TOO_FEW_SECTIONS' }]
    : [];
}

/** O bloco de soltos, quando vem, é o último. */
function looseIssues(sections: readonly StructureSectionInput[]): StructureIssue[] {
  const last = sections.length - 1;
  const misplaced = sections.some(
    (section, index) => section.id === LOOSE_SECTION_ID && index < last,
  );
  return misplaced ? [{ field: 'sections', code: 'LOOSE_NOT_LAST' }] : [];
}

/** Seção repetida: a repetição (da segunda em diante) é o problema, no campo `id` dela. */
function duplicatedSectionIssues(sections: readonly StructureSectionInput[]): StructureIssue[] {
  const seen = new Set<string>();
  const issues: StructureIssue[] = [];
  sections.forEach((section, index) => {
    if (seen.has(section.id)) {
      issues.push({ field: sectionField(index, 'id'), code: 'SECTION_DUPLICATED' });
    }
    seen.add(section.id);
  });
  return issues;
}

/** Categoria fora das 11 do módulo, pela chave sem acento ("Frios e Laticinios"). */
function unknownSectionIssues(
  sections: readonly StructureSectionInput[],
  categories: readonly string[],
): StructureIssue[] {
  const issues: StructureIssue[] = [];
  sections.forEach((section, index) => {
    if (section.id === LOOSE_SECTION_ID) return;
    const category = section.id.slice(CATEGORY_PREFIX.length);
    if (!categories.includes(category)) {
      issues.push({ field: sectionField(index, 'id'), code: 'SECTION_UNKNOWN' });
    }
  });
  return issues;
}

/** O mesmo item duas vezes, na mesma seção ou em outra: um problema por seção que traz repetição. */
function duplicatedItemIssues(sections: readonly StructureSectionInput[]): StructureIssue[] {
  const seen = new Set<string>();
  const issues: StructureIssue[] = [];
  sections.forEach((section, index) => {
    const repeated = section.itemIds.some((itemId) => {
      const already = seen.has(itemId);
      seen.add(itemId);
      return already;
    });
    if (repeated) issues.push({ field: sectionField(index, 'itemIds'), code: 'ITEM_DUPLICATED' });
  });
  return issues;
}

/**
 * Coerência do retrato: todos os problemas de uma vez, na ordem dos códigos do contrato (páginas, poucas seções, soltos,
 * seção repetida, seção desconhecida, item repetido). Lista vazia: o retrato é coerente. Só o corpo, sem banco.
 */
export function validateStructureState(
  request: StructureRequest,
  categories: readonly string[] = FLYER_PRO_CATEGORIES,
): StructureIssue[] {
  const { sections } = request;
  return [
    ...pageIssues(request),
    ...tooFewIssues(sections),
    ...looseIssues(sections),
    ...duplicatedSectionIssues(sections),
    ...unknownSectionIssues(sections, categories),
    ...duplicatedItemIssues(sections),
  ];
}

/** 422 `FLYER_PRO_STRUCTURE_STATE_INVALID` com todos os problemas em `issues`; retrato coerente passa. */
export function assertStructureState(request: StructureRequest): void {
  const issues = validateStructureState(request);
  if (issues.length > 0) throw flyerProStructureStateInvalid(issues);
}
