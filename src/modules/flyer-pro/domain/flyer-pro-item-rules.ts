import {
  FLYER_PRO_CATEGORIES,
  FLYER_PRO_IMAGE_ORIGINS,
  FLYER_PRO_UNITS,
} from './flyer-pro-categories';
import { canonicallyEqual } from './flyer-pro-canonical';
import { FlyerProItemIssue } from './flyer-pro.errors';
import { FLYER_PRO_LIMITS } from './flyer-pro.limits';
import { IMAGE_GROUP_KEYS, ItemDraft, ItemFieldKey } from './flyer-pro-item.types';
import { isSent } from './flyer-pro-presence';
import { priceIssueCode } from './flyer-pro-price-rules';
import { jsonBytes } from './flyer-pro-slices';

/**
 * As regras de valor do item mesclado, puras: devolvem todos os problemas de todos os itens de uma vez (`issues`, 422).
 * A forma (tipo de cada campo) já foi conferida pelo DTO (400). Só os campos que o corpo trouxe são conferidos; o que
 * está gravado não é reavaliado.
 */

type Issues = FlyerProItemIssue[];

const REQUIRED_KEYS = ['position', 'name', 'price', 'unit'] as const;
const EAN_LENGTHS = [8, 12, 13, 14];
const URL_PREFIXES = ['http://', 'https://', '/uploads/'];

const issue = (draft: ItemDraft, field: string, code: string): FlyerProItemIssue => ({
  itemId: draft.entry.id,
  field,
  code,
});

/** Item novo, ou toda entrada com `replaceAll`, traz os quatro obrigatórios; em item existente só `null` os apagaria. */
function requiredIssues(draft: ItemDraft): Issues {
  const complete = !draft.stored || draft.replaceAll;
  return REQUIRED_KEYS.filter((key) => {
    const value = draft.entry[key];
    return complete ? !isSent(value) : value === null;
  }).map((key) => issue(draft, key, 'REQUIRED_FIELD_MISSING'));
}

const oneOf = (list: readonly string[], value: unknown): boolean => list.includes(value as string);
const lengthOf = (value: unknown): number => (value as string).length;

/** O teste de valor de cada campo enviado e não nulo: o código do problema, ou `null` quando passa. */
const VALUE_CHECKS: ReadonlyArray<[ItemFieldKey, (value: unknown) => string | null]> = [
  [
    'name',
    (v) =>
      lengthOf(v) >= 1 && lengthOf(v) <= FLYER_PRO_LIMITS.itemNameMaxLength ? null : 'NAME_INVALID',
  ],
  [
    'sourceName',
    (v) => (lengthOf(v) <= FLYER_PRO_LIMITS.sourceNameMaxLength ? null : 'SOURCE_NAME_INVALID'),
  ],
  ['price', (v) => priceIssueCode(v as Record<string, unknown>)],
  ['unit', (v) => (oneOf(FLYER_PRO_UNITS, v) ? null : 'UNIT_UNKNOWN')],
  ['category', (v) => (oneOf(FLYER_PRO_CATEGORIES, v) ? null : 'CATEGORY_UNKNOWN')],
  ['ean', (v) => (isEan(v as string) ? null : 'EAN_FORMAT')],
];

const isEan = (value: string): boolean => /^\d+$/.test(value) && EAN_LENGTHS.includes(value.length);

function valueIssues(draft: ItemDraft): Issues {
  return VALUE_CHECKS.filter(([key]) => isSent(draft.entry[key])).flatMap(([key, check]) => {
    const code = check(draft.merged[key]);
    return code ? [issue(draft, key, code)] : [];
  });
}

const validUrl = (url: string): boolean =>
  url.length <= FLYER_PRO_LIMITS.imageUrlMaxLength && URL_PREFIXES.some((p) => url.startsWith(p));

/** URL e origem da foto, e o grupo inteiro: os cinco juntos, todos preenchidos ou todos nulos. */
function imageIssues(draft: ItemDraft): Issues {
  const { entry } = draft;
  const found: Issues = [];
  if (isSent(entry.imageUrl) && !validUrl(entry.imageUrl)) {
    found.push(issue(draft, 'imageUrl', 'IMAGE_URL_INVALID'));
  }
  if (
    isSent(entry.imageOrigin) &&
    !(FLYER_PRO_IMAGE_ORIGINS as readonly string[]).includes(entry.imageOrigin)
  ) {
    found.push(issue(draft, 'imageOrigin', 'IMAGE_ORIGIN_UNKNOWN'));
  }
  const partial = incompleteGroupField(draft);
  if (partial) found.push(issue(draft, partial, 'IMAGE_GROUP_PARTIAL'));
  return found;
}

/** O primeiro campo do grupo da foto que falta ou é nulo quando os cinco não andam juntos; `null` se estão em ordem. */
function incompleteGroupField(draft: ItemDraft): string | null {
  const { entry } = draft;
  if (IMAGE_GROUP_KEYS.every((key) => entry[key] === undefined)) return null;
  const allFilled = IMAGE_GROUP_KEYS.every((key) => isSent(entry[key]));
  const allNull = IMAGE_GROUP_KEYS.every((key) => entry[key] === null);
  if (allFilled || allNull) return null;
  return IMAGE_GROUP_KEYS.find((key) => !isSent(entry[key])) ?? null;
}

/** `imported` até 2 KB; `sourceName` e `imported` só na criação: em item existente, valor diferente é `IMMUTABLE_FIELD`. */
function importedIssues(draft: ItemDraft): Issues {
  const { entry, stored } = draft;
  const found: Issues = [];
  if (isSent(entry.imported) && jsonBytes(entry.imported) > FLYER_PRO_LIMITS.importedMaxBytes) {
    found.push(issue(draft, 'imported', 'IMPORTED_TOO_LARGE'));
  }
  if (!stored) return found;
  if (entry.sourceName !== undefined && entry.sourceName !== (stored.sourceName ?? null)) {
    found.push(issue(draft, 'sourceName', 'IMMUTABLE_FIELD'));
  }
  if (entry.imported !== undefined && !canonicallyEqual(entry.imported, stored.imported)) {
    found.push(issue(draft, 'imported', 'IMMUTABLE_FIELD'));
  }
  return found;
}

/**
 * `importId` só se grava na criação. Item novo: preenchido, tem de ser de uma importação conhecida (a do corpo ou uma do
 * encarte, lida de fora para a regra continuar pura); nulo ou ausente é item incluído à mão. Item existente: o valor
 * diferente do gravado, inclusive `null` sobre um valor, é `IMMUTABLE_FIELD`, sem conferir se a importação existe;
 * ausente mantém o gravado.
 */
function importLinkIssues(draft: ItemDraft, knownImports: ReadonlySet<string>): Issues {
  const { entry, stored } = draft;
  if (entry.importId === undefined) return [];
  if (stored) {
    return entry.importId === (stored.importId ?? null)
      ? []
      : [issue(draft, 'importId', 'IMMUTABLE_FIELD')];
  }
  const unknown = isSent(entry.importId) && !knownImports.has(entry.importId);
  return unknown ? [issue(draft, 'importId', 'IMPORT_UNKNOWN')] : [];
}

/** Decisão incompleta ou contraditória (D-1 (a)): nenhuma é engolida em silêncio. */
function decisionIssues(draft: ItemDraft): Issues {
  const { entry } = draft;
  const found: Issues = [];
  if (entry.spellDecision === 'accept' && !entry.name?.trim()) {
    found.push(issue(draft, 'spellDecision', 'DECISION_INVALID'));
  }
  if (isSent(entry.categoryDecisionReason) && entry.categoryDecision !== 'blocked') {
    found.push(issue(draft, 'categoryDecisionReason', 'DECISION_INVALID'));
  }
  if (entry.categoryDecision === 'accept' && !isSent(entry.category)) {
    found.push(issue(draft, 'categoryDecision', 'DECISION_INVALID'));
  }
  if (
    entry.imageDecision === 'reject' &&
    IMAGE_GROUP_KEYS.some((key) => entry[key] !== undefined)
  ) {
    found.push(issue(draft, 'imageDecision', 'DECISION_INVALID'));
  }
  return found;
}

/** Os ids de importação a conferir: os dos itens novos que se ligam a uma (sem repetição); item existente não conta. */
export const importIdsOfNewItems = (drafts: ItemDraft[]): string[] => [
  ...new Set(
    drafts.filter((d) => !d.stored && isSent(d.entry.importId)).map((d) => d.entry.importId),
  ),
];

/** Todos os problemas de um item; `knownImports` são os ids das importações a que um item novo pode se ligar. */
export function validateItem(draft: ItemDraft, knownImports: ReadonlySet<string>): Issues {
  return [
    ...requiredIssues(draft),
    ...valueIssues(draft),
    ...imageIssues(draft),
    ...importedIssues(draft),
    ...importLinkIssues(draft, knownImports),
    ...decisionIssues(draft),
  ];
}

/** Todos os problemas de todos os itens, na ordem dos itens. */
export const validateItems = (drafts: ItemDraft[], knownImports: ReadonlySet<string>): Issues =>
  drafts.flatMap((draft) => validateItem(draft, knownImports));
