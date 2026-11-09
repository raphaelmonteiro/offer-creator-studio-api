import { z } from 'zod';
import {
  ConceptColor,
  ConceptElement,
  ELEMENT_KINDS,
  ElementKind,
  HEADER_SHAPES,
  HeaderShape,
  REFERENCE_LIMITS,
  REFERENCE_PLACES,
  ReferenceConcept,
  ReferencePlace,
  Removal,
} from './scene-reference.types';
import { dropSentencesWithTerms, SECTION_COLOR_ROLE, termGroupOf } from './scene-reference-terms';

/**
 * O sanitizador da ficha-conceito: função pura entre a saída da visão e o prompt da imagem. Tira tudo o que é conteúdo
 * ou identidade (logo e o selo ou medalhão da logo, D-1; símbolos de varejo; texto; pessoas; códigos; seções) e grava o
 * motivo de cada remoção. A altura do cabeçalho da ficha é sempre descartada: quem manda é a zona do formato.
 */

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** `string` que não é string vira vazio; corta no limite. */
const text = (value: unknown, max: number = REFERENCE_LIMITS.fieldMaxLength): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A leitura da visão serve? `notFlyer` quando ela diz que a imagem não é um encarte; `invalid` sem forma de ficha. */
export type RawReading = { kind: 'ok' } | { kind: 'not_flyer' } | { kind: 'invalid' };

const rawShape = z
  .object({
    is_retail_flyer: z.boolean().optional(),
    signature_elements: z.array(z.unknown()).optional(),
    palette: z.array(z.unknown()).optional(),
  })
  .passthrough();

export function readRaw(raw: unknown): RawReading {
  const parsed = rawShape.safeParse(raw);
  if (!parsed.success) return { kind: 'invalid' };
  if (parsed.data.is_retail_flyer === false) return { kind: 'not_flyer' };
  const { signature_elements: elements, palette } = parsed.data;
  return elements || palette ? { kind: 'ok' } : { kind: 'invalid' };
}

const PLACE_ALIASES: Readonly<Record<string, ReferencePlace>> = {
  'top right': 'corners',
  'top left': 'corners',
  'bottom right': 'corners',
  'bottom left': 'corners',
  top: 'top edge',
  bottom: 'bottom edge',
  left: 'left edge',
  right: 'right edge',
  background: 'whole background',
};

/** `where` no conjunto fechado, ou `null` (enfeite de seção ou lugar desconhecido). */
export function normalizePlace(value: string): ReferencePlace | null {
  const key = value.trim().toLowerCase();
  const known = REFERENCE_PLACES.find((place) => place === key);
  return known ?? PLACE_ALIASES[key] ?? null;
}

/** O formato do cabeçalho no conjunto fechado: a primeira palavra do conjunto que o texto cita, ou `''`. */
export function normalizeShape(value: string): HeaderShape | '' {
  const lower = value.toLowerCase();
  return HEADER_SHAPES.find((shape) => new RegExp(`(?<![\\p{L}])${shape}`, 'u').test(lower)) ?? '';
}

const kindOf = (value: unknown): ElementKind | null =>
  ELEMENT_KINDS.find((kind) => kind === value) ?? null;

type Removals = Removal[];

function cleanElements(raw: unknown, removed: Removals): ConceptElement[] {
  const kept: ConceptElement[] = [];
  for (const entry of list(raw)) {
    const row = record(entry);
    const element = text(row.element);
    const labelPt = text(row.label_pt);
    const notes = text(row.notes);
    const kind = kindOf(row.kind);
    const reason = termGroupOf(`${element} ${labelPt} ${notes}`);
    const where = normalizePlace(text(row.where));
    if (!element) continue;
    // A regra principal é o campo fechado `kind`; a tabela de termos é a segunda linha de defesa.
    if (kind === 'logo_or_badge') {
      removed.push({ field: 'signature_elements', text: element, reason: 'logo_badge' });
    } else if (kind === 'section_decoration') {
      removed.push({
        field: 'signature_elements',
        text: element,
        reason: 'section_or_unknown_place',
      });
    } else if (!kind) {
      removed.push({ field: 'signature_elements', text: element, reason: 'invalid' });
    } else if (reason) {
      removed.push({ field: 'signature_elements', text: element, reason });
    } else if (!where) {
      removed.push({
        field: 'signature_elements',
        text: element,
        reason: 'section_or_unknown_place',
      });
    } else {
      kept.push({ element, labelPt: labelPt || element, where, notes });
    }
  }
  if (kept.length > REFERENCE_LIMITS.maxElements) kept.length = REFERENCE_LIMITS.maxElements;
  return kept;
}

function cleanPalette(raw: unknown, removed: Removals): ConceptColor[] {
  const kept: ConceptColor[] = [];
  for (const entry of list(raw)) {
    const row = record(entry);
    const hex = text(row.hex);
    const role = text(row.role);
    if (!HEX.test(hex)) {
      removed.push({ field: 'palette', text: hex, reason: 'invalid' });
    } else if (SECTION_COLOR_ROLE.test(role)) {
      removed.push({ field: 'palette', text: `${hex} (${role})`, reason: 'section_color' });
    } else {
      const upper = hex.toUpperCase();
      const name = text(row.name_pt);
      const nameReason = name ? termGroupOf(name) : null;
      if (nameReason) removed.push({ field: 'palette.name_pt', text: name, reason: nameReason });
      kept.push({ hex: upper, namePt: name && !nameReason ? name : upper, role });
    }
  }
  return kept.slice(0, REFERENCE_LIMITS.maxPalette);
}

/** Campo livre: sai só a oração que tem o termo; o que fica vazio sai. */
function cleanFree(field: string, value: unknown, removed: Removals): string {
  const { kept, dropped } = dropSentencesWithTerms(text(value));
  for (const item of dropped) removed.push({ field, ...item });
  return kept;
}

const strings = (value: unknown): string[] =>
  list(value)
    .map((item) => text(item))
    .filter(Boolean);

/** A ficha crua da visão, limpa. Nunca lança: entrada fora da forma vira ficha vazia (o turno valida antes). */
export function sanitizeConcept(raw: unknown): { concept: ReferenceConcept; removed: Removal[] } {
  const row = record(raw);
  const header = record(row.header);
  const removed: Removals = [];
  const concept: ReferenceConcept = {
    theme: cleanFree('theme', row.theme, removed),
    themePt: cleanFree('theme_pt', row.theme_pt, removed),
    elements: cleanElements(row.signature_elements, removed),
    backgroundTexture: cleanFree('background_texture', row.background_texture, removed),
    backgroundTexturePt: cleanFree('background_texture_pt', row.background_texture_pt, removed),
    palette: cleanPalette(row.palette, removed),
    header: {
      shape: normalizeShape(text(header.shape)),
      fill: cleanFree('header.fill', header.fill, removed),
    },
    bodySuggestion: cleanFree('body_suggestion', row.body_suggestion, removed),
    ignoredSections: strings(row.ignored_sections),
    ignoredContent: strings(row.ignored_content),
  };
  if (header.height_pct !== undefined && header.height_pct !== null) {
    removed.push({
      field: 'header.height_pct',
      text: String(header.height_pct),
      reason: 'zones_rule',
    });
  }
  return { concept, removed };
}
