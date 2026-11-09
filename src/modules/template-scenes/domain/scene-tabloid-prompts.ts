import { cleanRequest } from './scene-clean-text';
import { ReferenceConcept } from './scene-reference.types';
import { outerConceptBlock, REFERENCE_PARAGRAPH, tintLabel } from './scene-reference-prompts';
import { SceneFormatSpec } from './scene-formats';
import { TabloidFaceKey, tabloidMeasures, TabloidMeasures } from './scene-tabloid';
import { SceneZones } from './scene.types';

/**
 * Prompts do jornal de 4 páginas (change add-template-scene-tabloid, PV-T6 e PV-T7), em inglês, os do teste pago de
 * 2026-11-08 com as medidas em px escritas pelo código. Nunca levam ano nem item do brief; a Interna nunca leva o
 * pedido do cliente. Cenas `single` e `front_back` não passam por aqui.
 */

export interface TabloidPromptInput {
  format: SceneFormatSpec;
  widthPx: number;
  heightPx: number;
  /** Zonas da face (a altura do cabeçalho é a da versão em curso, D-1). */
  zones: SceneZones;
}

export interface OuterPromptInput extends TabloidPromptInput {
  /** Pedido do cliente (tema, humor, cores e decoração do cabeçalho). */
  request: string;
  /** Itens em aberto do brief: só a imagem nova na Externa passa isto. */
  openItems?: string[];
  /** Linhas de `exact_text` (D-52): único texto da imagem, só no cabeçalho. */
  exactText?: string[];
  /** Linhas de correção da refação do texto (o juiz leu diferente do pedido), antes do bloco de texto. */
  correctionLines?: string[];
  /** Ficha limpa do encarte de referência (D-2): no lugar do pedido, sem texto e sem selo. */
  concept?: ReferenceConcept;
}

const measuresOf = (input: TabloidPromptInput): TabloidMeasures =>
  tabloidMeasures(input.zones, input);

/** "55 x 41 cm (54 x 40 cm trim plus 0.5 cm bleed), landscape, 3328x2480 px". */
function sheetText(format: SceneFormatSpec, m: TabloidMeasures): string {
  const bleed = (format.artWidthCm - format.printWidthCm) / 2;
  return `sheet art of ${format.artWidthCm} x ${format.artHeightCm} cm (${format.printWidthCm} x ${format.printHeightCm} cm trim plus ${bleed} cm bleed), landscape, ${m.width}x${m.height} px, filling the whole canvas edge to edge`;
}

const foldStrip = (m: TabloidMeasures): string => `x from ${m.foldFrom} to ${m.foldTo} px`;

const NO_TEXT = 'no text, no letters, no numbers, no logo, no watermark';
const NO_BRANDS = 'No real brands or real product packaging.';
/** Com a referência (D-1): o espaço da logo fica liso, sem selo nem medalhão no lugar dela. */
const NO_BADGES =
  'No badges, no medallions, no seals, no emblems, no empty round frames or placeholder shapes; the logo space stays plain soft background.';

/** Bloco de texto da Externa: o texto pedido, copiado, só no cabeçalho; sem pedido, nenhum texto. */
function outerTextBlock(lines: string[] | undefined): string {
  if (!lines?.length) return `Text: ${NO_TEXT}. ${NO_BRANDS}`;
  const numbered = lines.map((line, index) => `Line ${index + 1}: "${cleanRequest(line)}"`);
  return `Text: put this exact Portuguese text, copied character by character, inside the header only: ${numbered.join(' ')} Never invent or add any other text, numbers, prices, dates, store names, logos, QR codes or watermark. ${NO_BRANDS}`;
}

function openItemsText(items: string[] | undefined): string {
  if (!items?.length) return '';
  const list = items.map((item) => cleanRequest(item).replace(/[.!]+$/, '')).join('; ');
  return ` Other client requests still open (Portuguese): ${list}.`;
}

/** Folga do cabeçalho (D-9): o modelo passa do limite em px, então o ponto mais baixo pedido é 80% do limite. */
const HEADER_SAFE = 0.8;
/** Margem entre o espaço da logo e a arte do cabeçalho, em px. */
const LOGO_GAP = 48;

/** O estilo rico das duas faces (D-9): o fundo é contínuo e decorado; só o miolo de produtos fica sem objetos grandes. */
const RICH_STYLE =
  "Style: a rich, finished, professional retail-flyer artwork, as good as a top graphic designer's work. The whole sheet has a lush continuous background: subtle paper or fabric texture, soft gradients, gentle light, soft bokeh and decorative elements of the theme (the same family of elements everywhere) spread along ALL the outer edges and corners of BOTH halves, always fading toward the center. Colors are saturated and harmonious. Never a flat blank wash.";

/**
 * Prompt da primeira imagem e da imagem nova da Externa (PV-T6, D-9): fundo rico e contínuo nas duas metades, só o
 * miolo de produtos sem objetos grandes; cabeçalho só na capa, com folga sobre o limite em px, base em fita ou curva e
 * a arte depois do espaço da logo; faixa do rodapé da contracapa opaca, com fita no topo e fim reto na faixa da dobra.
 */
export function buildOuterPrompt(input: OuterPromptInput): string {
  const m = measuresOf(input);
  const { format } = input;
  const side = format.printWidthCm / 2;
  const logoEnd = m.logoX + m.logoSize;
  const lowest = Math.round(m.headerEnd * HEADER_SAFE);
  return [
    'Create a new image: the OUTER side of a 4-page supermarket newspaper flyer, as print-ready background artwork. Only the painted background, the cover header and the back-cover footer band are drawn; the products, the logo and the store text are added later by another tool.',
    input.concept
      ? outerConceptBlock(input.concept)
      : `Client request (Portuguese, follow its theme, mood, colors and header decoration): "${cleanRequest(input.request)}".${openItemsText(input.openItems)}`,
    `Format and use: ${sheetText(format, m)}. The sheet is printed on both sides and folded vertically at the exact center (x = ${m.foldX} px) into two pages of ${side} x ${format.printHeightCm} cm: the LEFT half is the back cover and the RIGHT half is the front cover. The background is ONE continuous picture that crosses the fold with no seam, no border and no visible dividing line.`,
    RICH_STYLE,
    ...(input.concept
      ? [
          `The open product areas keep a soft tint of ${tintLabel(input.concept)}, never pure white.`,
        ]
      : []),
    `Composition: (a) RIGHT half: a cover header strictly confined to y from 0 to ${m.headerEnd} px and strictly to the right of x = ${m.headerX} px, spreading up to the right edge. The lowest point of any header element must be at y = ${lowest} px or higher, and never lower than ${m.headerEnd} px: the header is a shallow strip at the top, and the open area starts right below it. Its lower edge is never a straight cut: it ends in a ribbon, a wave or a soft curve. Keep a clean empty space of ${m.logoSize} x ${m.logoSize} px at the top-left of the header (x from ${m.logoX} to ${logoEnd}, y from ${m.logoY} to ${m.logoY + m.logoSize}) with only soft background, for the client logo placed later: no title, letters or decoration may enter it, and the header artwork starts at x = ${logoEnd + LOGO_GAP}. (b) Below the header the right half (y from ${m.headerEnd + 20} to ${m.height} px) keeps the same rich background, with decorative elements only near the right and bottom edges; the central product area stays open, with no large objects and no strong contrast. (c) LEFT half: the same rich background with decorative elements along its top, left and bottom edges; no header, and the central product area stays open. (d) A finished footer band at the bottom of the left half: a solid, opaque band in a deep tone of the theme, x from 0 to ${m.footerEndX} px and y from ${m.footerStart} to ${m.height} px, with a ribbon-like curved top edge (a gentle wave with a thin lighter accent line), a clean straight end at x = ${m.footerEndX} px, nothing drawn on it. It never fades, blurs or dissolves. (e) Keep a vertical safe strip ${m.foldTo - m.foldFrom} px wide centered on the fold (${foldStrip(m)}) with no object and no light source: only the continuous background texture may cross it.`,
    ...(input.correctionLines ?? []),
    ...(input.concept ? [REFERENCE_PARAGRAPH, NO_BADGES] : []),
    outerTextBlock(input.concept ? undefined : input.exactText),
  ].join('\n');
}

/**
 * Prompt fixo da derivação da Interna (PV-T7, D-9): edita a Externa, tira cabeçalho e rodapé e dá às páginas de dentro
 * a mesma linguagem decorativa, arte contínua e sem calha. Nunca leva pedido do cliente, ano nem brief.
 */
export function buildInnerPrompt(input: TabloidPromptInput): string {
  const m = measuresOf(input);
  return [
    'Edit the provided image. It is the OUTER side of a 4-page newspaper flyer. Create the INNER side of the same sheet from it: the same printed piece, the same artwork family, with the header, its title and the footer band removed.',
    `Format and use: ${sheetText(input.format, m)}. The inner side is the spread of pages 2 and 3, folded vertically at the exact center (x = ${m.foldX} px), seen as ONE continuous screen with no seam, no border and no visible dividing line.`,
    `Composition: remove the header and its decoration and the footer band completely, from the top edge to the bottom edge, and paint the background there as the natural continuation of the same picture. Give the inner side the same decorative language as the outer side: the same lush background texture and the same family of decorative elements and light along ALL four outer edges and corners of the sheet, as richly as the outer side, fading toward the center. The center of both pages stays open for product cards, with no large objects and no strong contrast. No header, no footer band, no title, no text. Keep a vertical safe strip ${m.foldTo - m.foldFrom} px wide centered on the fold (${foldStrip(m)}) with only the continuous background texture, no object and no light source. Do NOT draw a gutter, book-spine shadow, darker or lighter vertical band, crease or page edge at the center: the color and brightness at x = ${m.foldX} px must match the color and brightness 400 px to its left and right.`,
    'Style: keep exactly the same style as the provided image: the same colors, lighting, motifs, texture and print quality, so the two sides of the sheet look like the same piece.',
    'Preserve: the color palette, the lighting, the texture and the motifs style of the provided image, and the same canvas size and proportion.',
    `Text: ${NO_TEXT}.`,
  ].join('\n');
}

const NO_NEW_TEXT = 'Do not add any text, letters, numbers or logos.';

/**
 * Frase de preservação das edições (fim do `buildEditPrompt`, como a do verso). Sem texto pedido pelo cliente, proíbe
 * texto novo; com `exact_text` (D-4), a parte "sem texto" sai.
 */
export function tabloidPreservationSentence(
  key: TabloidFaceKey,
  input: TabloidPromptInput & { withClientText: boolean },
): string {
  const m = measuresOf(input);
  const strip = `the vertical strip from x = ${m.foldFrom} to ${m.foldTo} px`;
  const base =
    key === 'outer'
      ? `This is the OUTER side of a 4-page folded flyer: the left half is the back cover and the right half is the front cover, folded at x = ${m.foldX} px. Keep the cover header only in the right half, right of x = ${m.headerX} px and above y = ${m.headerEnd} px, with its lower edge ending in a ribbon or curve, never a straight cut. Keep ${strip} plain background, with no objects and no light source. Keep the footer band of the left half (x < ${m.footerEndX} px, y ≥ ${m.footerStart} px) calm, with no objects.`
      : `This is the INNER spread of a 4-page folded flyer (pages 2 and 3), folded at x = ${m.foldX} px: it has no header and no footer. Do not add a header, a title or a footer band. Keep ${strip} plain, even background. Do NOT draw a gutter, book-spine shadow or darker or lighter vertical band at the center.`;
  return input.withClientText ? base : `${base} ${NO_NEW_TEXT}`;
}

export type TabloidSide = 'left' | 'center' | 'right' | null;

/**
 * Região da edição no jornal (PV-T3): a descrição em px com a meia largura. `zone` já é a efetiva da face (a que a
 * face não tem virou miolo). Devolve só o trecho depois de "Make the change ".
 */
export function tabloidRegionText(
  key: TabloidFaceKey,
  input: TabloidPromptInput & { zone: 'header' | 'footer' | 'body'; side: TabloidSide },
): string {
  const m = measuresOf(input);
  const { zone, side } = input;
  const fold = `the fold strip x ${m.foldFrom} to ${m.foldTo} px`;
  if (key === 'inner') {
    if (side === 'left') return `only on page 2 (left half, x < ${m.foldFrom} px).`;
    if (side === 'right') return `only on page 3 (right half, x > ${m.foldTo} px).`;
    return `only in the free product area of the spread (pages 2 and 3), never inside ${fold}.`;
  }
  if (zone === 'header') {
    return `only inside the cover header in the right half: x from ${m.headerX} to ${m.width} px, y < ${m.headerEnd} px.`;
  }
  if (zone === 'footer') {
    return `only inside the footer band of the back cover: x from 0 to ${m.footerEndX} px, y ≥ ${m.footerStart} px.`;
  }
  if (side === 'left') {
    return `only on the back cover (left half, x < ${m.foldFrom} px), above the footer band.`;
  }
  if (side === 'right') {
    return `only on the front cover (right half, x > ${m.foldTo} px), below the header.`;
  }
  return `only in the free product area (the left half above the footer band and the right half below the header), never inside ${fold}.`;
}
