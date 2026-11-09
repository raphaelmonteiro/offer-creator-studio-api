import { cleanRequest } from './scene-clean-text';
import { ConceptColor, ConceptElement, ReferenceConcept } from './scene-reference.types';
import { bodyTint } from './scene-reference-summary';
import { SceneZones } from './scene.types';

/**
 * Prompts da referência de encarte (change add-template-scene-from-reference), em inglês, a partir dos literais do
 * estudo pago de 2026-11-09 (`estudo/rodada-2`). O código preenche as medidas: a altura do cabeçalho vem das zonas da
 * face, nunca da ficha, e o corpo leva a tinta da paleta (PV-R8).
 */

const CONCEPT_PROMPT = `You are an art director analysing a retail flyer ONLY to extract its ART CONCEPT (theme and signature artwork) for a new, original background template. The new template will have a decorated header/edges and a calm, empty body; product sections are created later by a separate editor, so section structure must be discarded.

DISCARD as section structure (list them in "ignored_sections", never describe them elsewhere): product section panels, colored section blocks, day/weekday columns, section title bars, product grids, cards, dividers between product groups, and any decoration that belongs to one section only (e.g. an awning over a produce section, fire over a meat section, grass or wood planks under a fruit section).

DISCARD as brand identity (list them in "ignored_content", never describe them elsewhere): the store logo and anything around it, and any badge, medallion, seal, emblem, rosette, crest, stamp or round frame that holds a logo, a store name, a campaign title, a price or a symbol (shopping cart, coin, currency sign). These belong to the logo and must not become decorations.

Classify EVERY item of "signature_elements" with "kind", whatever words you use to name it: "logo_or_badge" for any medallion, badge, seal, emblem, rosette, crest, stamp, round frame, coin or cart ornament, or anything that sits around, holds or stands for the logo, the store name, a campaign title, a price or a symbol; "section_decoration" for any decoration tied to one product section (awning, flames, grass, wood planks, section ribbons); "decoration" ONLY for free artwork of the theme itself (bunting, checker fabric, sparkles, light rays, bokeh, ribbons of the header). When in doubt between "decoration" and another kind, choose the other kind.

Only describe what you can actually see in the image. Do not add elements that are not there.

Return ONLY a JSON object with exactly these keys:
{
  "is_retail_flyer": true|false,
  "theme": "season/holiday/occasion and mood in one sentence (e.g. Brazilian June festival, October sale, anniversary)",
  "theme_pt": "the same theme in Brazilian Portuguese, short (e.g. festa junina, ofertas de outubro)",
  "signature_elements": [{"element": "generic artwork element, e.g. triangular paper bunting, blue checker fabric texture, sparkles, geometric light rays", "label_pt": "short Brazilian Portuguese name, e.g. bandeirinhas de São João", "kind": "decoration|logo_or_badge|section_decoration", "where": "header|top edge|bottom edge|left edge|right edge|corners|whole background", "notes": "color, size, style"}],
  "background_texture": "the texture/field behind everything (e.g. blue rays with halftone dots, checker fabric, soft gradient)",
  "background_texture_pt": "the same in Brazilian Portuguese, short",
  "palette": [{"hex": "#RRGGBB", "name_pt": "color name in Brazilian Portuguese", "role": "header, accent, body background, edge decoration..."}] (4 to 7 colors, theme colors only, no section block colors),
  "header": {"shape": "straight|curved|wave|diagonal|arch", "height_pct": number, "fill": "texture/colors/decorations, abstract terms only"},
  "body_suggestion": "how a calm, empty body should look to match the concept (light tint of the theme colors, soft gradient, subtle texture)",
  "ignored_sections": ["each discarded section structure or section-tied decoration, described generically"],
  "ignored_content": ["categories present that must never be reproduced: logos, badges or medallions of the logo, store names, brands, product imagery, prices, texts, dates, people, mascots, QR codes, payment logos, social icons"]
}

Vocabulary rules: never use the words photography, photo, shelf, shelves, lettering, letters, text, title, price, collage, product, food, packaging in "theme", "signature_elements", "background_texture", "palette", "header" or "body_suggestion". Replace them with abstract art terms (e.g. "warm blurred bokeh" instead of shelf photography). Never write any word that is printed on the flyer.`;

/** O prompt da ficha; na correção do cliente (D-3), leva o pedido e a ficha limpa anterior. */
export function buildConceptPrompt(correction?: {
  note: string;
  previous: ReferenceConcept;
}): string {
  if (!correction) return CONCEPT_PROMPT;
  const note = cleanRequest(correction.note);
  return `${CONCEPT_PROMPT}\nClient correction (Brazilian Portuguese), apply it to the concept: "${note}". The previous concept was: ${JSON.stringify(correction.previous)}.`;
}

/** O parágrafo da referência: só estilo, sem layout, sem seções e sem conteúdo ou identidade. */
export const REFERENCE_PARAGRAPH =
  'The attached reference image is ONLY a style reference for the theme, the signature decorative elements, the texture and the palette. Do NOT copy its layout. Do NOT create any panels, boxes, cards, colored section blocks, columns, title bars, divider bands, grids or frames in the body. Do NOT reproduce anything from the reference that is content or identity: products, food, logos, logo badges or medallions, store or brand names, any text or numbers, prices, people, QR codes, payment logos. The body must stay calm so a flyer editor can lay out product sections on top later. High print quality, crisp decorative details.';

/** As proibições da frente do prompt, com o selo e o medalhão da logo (D-1). */
const NOTHING_ELSE =
  'Absolutely no text, no letters, no numbers, no logos, no brand names, no badges, no medallions, no seals, no emblems, no empty round frames or placeholder shapes, no products, no food, no packaging, no prices, no price tags, no people, no QR codes, no icons.';

/** Folga do cabeçalho (D-9 do jornal): o ponto mais baixo pedido é 85% do limite em px. */
export const HEADER_SOFT_SHARE = 0.85;

const phrase = (item: ConceptElement): string =>
  item.notes ? `${item.element} (${item.notes})` : item.element;

const join = (items: ConceptElement[]): string => items.map(phrase).join('; ');

/** Os elementos por lugar: cabeçalho, faixa de baixo e o resto (bordas, cantos, fundo). */
export function placesOf(concept: ReferenceConcept) {
  const at = (...where: ConceptElement['where'][]) =>
    concept.elements.filter((item) => where.includes(item.where));
  return {
    header: at('header'),
    bottom: at('bottom edge'),
    edges: at('top edge', 'left edge', 'right edge', 'corners', 'whole background'),
  };
}

/** A paleta no prompt: nome e hex; com menos de 3 cores, só os nomes. */
export function paletteList(palette: ConceptColor[]): string {
  if (palette.length === 0) return 'the colors of the theme';
  return palette
    .map((color) =>
      palette.length < 3 || color.namePt === color.hex
        ? color.namePt
        : `${color.namePt} ${color.hex}`,
    )
    .join(', ');
}

const headerFillOf = (concept: ReferenceConcept): string =>
  concept.header.fill || 'the theme colors and texture';

const textureOf = (concept: ReferenceConcept): string =>
  concept.backgroundTexture || concept.backgroundTexturePt || 'a soft gradient of the theme colors';

const themeOf = (concept: ReferenceConcept): string => concept.theme || concept.themePt;

/** O nome e o hex da tinta do corpo (PV-R8), iguais na face única e na Externa do jornal. */
export function tintLabel(concept: ReferenceConcept): string {
  const tint = bodyTint(concept);
  return `${tint.nameEn} ${tint.hex}`;
}

/** O bloco do conceito da Externa do jornal (D-2): no lugar do pedido do cliente. */
export function outerConceptBlock(concept: ReferenceConcept): string {
  const { header, edges } = placesOf(concept);
  const headerPart = [headerFillOf(concept), join(header)].filter(Boolean).join('; ');
  return `Art concept from the reference flyer (follow its theme, signature elements, texture and palette): Theme: ${themeOf(concept)}. Header: ${headerPart}. Edges: ${edges.length ? join(edges) : 'no decorations on the edges'}. Background texture: ${textureOf(concept)}. Palette: ${paletteList(concept.palette)}.`;
}

export interface ReferencePromptInput {
  artWidthCm: number;
  artHeightCm: number;
  widthPx: number;
  heightPx: number;
  /** Zonas da face: a altura do cabeçalho e do rodapé em px saem delas, nunca da ficha. */
  zones: SceneZones;
  concept: ReferenceConcept;
}

/** O prompt da imagem de uma face a partir da ficha limpa (`single` e a Frente do `front_back`). */
export function buildReferencePrompt(input: ReferencePromptInput): string {
  const { concept, widthPx, heightPx } = input;
  const headerPx = Math.round(input.zones.header.h * heightPx);
  const footerPx = Math.round(input.zones.footer.h * heightPx);
  const softPx = Math.round(HEADER_SOFT_SHARE * headerPx);
  const orientation = input.artHeightCm > input.artWidthCm ? 'portrait' : 'landscape';
  const { header, bottom, edges } = placesOf(concept);
  const bottomEdge = bottom.length
    ? `Along the bottom ${footerPx} px, a thin ${join(bottom)} strip.`
    : '';
  return [
    `Original background template for a printed retail flyer, ${orientation} ${input.artWidthCm} x ${input.artHeightCm} cm, ${widthPx}x${heightPx} px, filling the whole canvas edge to edge. Theme: ${themeOf(concept)}. ${NOTHING_ELSE}`,
    '',
    'Concept:',
    `- Header: the decorated header is strictly confined to the top ${headerPx} px (y from 0 to ${headerPx}); keep its lowest decoration above y = ${softPx} px. Lower edge: ${concept.header.shape || 'a soft curve'}. Fill: ${headerFillOf(concept)}. ${header.length ? join(header) : 'Keep the header simple.'}`,
    `- Edges: ${edges.length ? join(edges) : 'No decorations on the edges.'}`,
    `- Background texture: ${textureOf(concept)}, strongest in the header and along the edges.`,
    `- Body (from y = ${headerPx} to the bottom): one calm, continuous surface with a soft tint of ${tintLabel(concept)}, never pure white, keeping the palette (${paletteList(concept.palette)}) visible as a very gentle gradient or very subtle texture. ${bottomEdge}`.trimEnd(),
    '',
    REFERENCE_PARAGRAPH,
  ].join('\n');
}
