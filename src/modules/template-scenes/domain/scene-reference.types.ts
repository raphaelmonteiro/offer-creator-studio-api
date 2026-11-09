/**
 * Tipos da referência de encarte (change add-template-scene-from-reference): a ficha-conceito que a visão extrai de um
 * encarte, já limpa pelo sanitizador, e o estado dela em `version.metrics.reference` da versão `read_reference`.
 */

/** Onde o enfeite está: o conjunto fechado (o que não está no cabeçalho, nas bordas ou no fundo é enfeite de seção). */
export const REFERENCE_PLACES = [
  'header',
  'top edge',
  'bottom edge',
  'left edge',
  'right edge',
  'corners',
  'whole background',
] as const;
export type ReferencePlace = (typeof REFERENCE_PLACES)[number];

/**
 * O campo fechado de cada elemento-assinatura (R1): a visão classifica, o sanitizador derruba pelo campo. Só
 * `decoration` chega ao prompt; ausente ou fora do conjunto, o elemento cai (falha fechada).
 */
export const ELEMENT_KINDS = ['decoration', 'logo_or_badge', 'section_decoration'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** O formato da borda de baixo do cabeçalho: conjunto fechado (R2); fora dele, o prompt usa "a soft curve". */
export const HEADER_SHAPES = ['straight', 'curved', 'wave', 'diagonal', 'arch'] as const;
export type HeaderShape = (typeof HEADER_SHAPES)[number];

/** Por que o sanitizador tirou algo da ficha (gravado em `removed`, para auditar e ajustar a lista de termos). */
export type RemovalReason =
  | 'brand'
  | 'logo_badge'
  | 'retail_symbol'
  | 'content'
  | 'text'
  | 'people'
  | 'codes'
  | 'section_color'
  | 'section_or_unknown_place'
  | 'zones_rule'
  | 'invalid';

export interface Removal {
  field: string;
  text: string;
  reason: RemovalReason;
}

export interface ConceptElement {
  element: string;
  labelPt: string;
  where: ReferencePlace;
  notes: string;
}

export interface ConceptColor {
  hex: string;
  namePt: string;
  role: string;
}

/** A ficha limpa: só o que vai ao prompt (tema, enfeites, textura, paleta, cabeçalho sem altura) e o que fica de fora. */
export interface ReferenceConcept {
  theme: string;
  themePt: string;
  elements: ConceptElement[];
  backgroundTexture: string;
  backgroundTexturePt: string;
  palette: ConceptColor[];
  header: { shape: HeaderShape | ''; fill: string };
  bodySuggestion: string;
  ignoredSections: string[];
  ignoredContent: string[];
}

/** O que o cartão mostra (pt-BR), sem nova chamada. */
export interface ReferenceSummary {
  theme: string;
  uses: string[];
  colors: Array<{ hex: string; name: string }>;
  body: string;
  leftOut: string[];
}

export const REFERENCE_STATES = ['reading', 'proposed', 'used', 'discarded', 'failed'] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];

export interface ReferenceOrigin {
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png';
  bytes: number;
  widthPx: number;
  heightPx: number;
  sha256: string;
  uploadedByUserId: string | null;
  uploadedAt: string;
}

/** `version.metrics.reference` da versão `read_reference`. */
export interface ReferenceRead {
  state: ReferenceState;
  assetId: string;
  origin: ReferenceOrigin;
  /** Correção do cliente (D-3), pt-BR, até 500 caracteres. */
  note?: string;
  /** Versão da leitura anterior que esta corrige. */
  correctionOf?: string;
  raw?: unknown;
  concept?: ReferenceConcept;
  removed?: Removal[];
  summary?: ReferenceSummary;
  model?: string;
  prompt?: string;
  /** Versões `generate` nascidas desta ficha. */
  usedByVersionIds?: string[];
}

export const REFERENCE_LIMITS = {
  maxBytes: 20 * 1024 * 1024,
  minEdgePx: 800,
  /** Lado maior da cópia reduzida que vai aos modelos. */
  reducedEdgePx: 1536,
  reducedQuality: 85,
  noteMaxLength: 500,
  /** Correções por encarte (D-3). */
  maxRevisions: 5,
  maxElements: 6,
  maxPalette: 7,
  fieldMaxLength: 240,
} as const;
