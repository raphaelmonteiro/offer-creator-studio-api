import { cleanRequest } from './scene-clean-text';
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

/**
 * Prompt da primeira imagem e da imagem nova da Externa (PV-T6): cabeçalho só na capa, com limite em px e base em
 * fita ou curva; espaço da logo; capa livre abaixo; contracapa livre; faixa do rodapé até a faixa da dobra; faixa de
 * segurança da dobra.
 */
export function buildOuterPrompt(input: OuterPromptInput): string {
  const m = measuresOf(input);
  const { format } = input;
  const side = format.printWidthCm / 2;
  const logoEnd = m.logoX + m.logoSize;
  return [
    'Create a new image: the OUTER side of a 4-page supermarket newspaper flyer, as print-ready background artwork. Only the painted background and the cover header are drawn; the products, the logo and the store footer are added later by another tool.',
    `Client request (Portuguese, follow its theme, mood, colors and header decoration): "${cleanRequest(input.request)}".${openItemsText(input.openItems)}`,
    `Format and use: ${sheetText(format, m)}. The sheet is printed on both sides and folded vertically at the exact center (x = ${m.foldX} px) into two pages of ${side} x ${format.printHeightCm} cm: the LEFT half is the back cover and the RIGHT half is the front cover. The background is ONE continuous picture that crosses the fold with no seam, no border and no visible dividing line.`,
    `Composition: (a) RIGHT half: a cover header strictly confined to y from 0 to ${m.headerEnd} px and strictly to the right of x = ${m.headerX} px, spreading up to the right edge. The header must not be taller than ${m.headerEnd} px. Its lower edge is never a straight cut: it ends in a ribbon, a wave or a soft curve. Reserve a clean empty space of ${m.logoSize} x ${m.logoSize} px at the top-left of the header (x from ${m.logoX} to ${logoEnd}, y from ${m.logoY} to ${m.logoY + m.logoSize}) with only soft background, for the client logo placed later. (b) Below the header the right half (y from ${m.headerEnd + 20} to ${m.height} px) is free: only calm, uniform background, no objects. (c) LEFT half: entirely free calm background, with no header, no objects and no illustration. Keep every light source, sun or ray burst in the upper right part of the right half, far from the fold, fading before the left half. (d) A plain footer band at the bottom of the left half (y from ${m.footerStart} to ${m.height} px, x from 0 to ${m.footerEndX} px): flat, uniform, slightly darker, with no pattern and nothing drawn; it fades softly into the background before x = ${m.footerEndX} px, without a hard edge. (e) Keep a vertical safe strip ${m.foldTo - m.foldFrom} px wide centered on the fold (${foldStrip(m)}) without any object, light source or important element: only plain background may cross it.`,
    'Style: clean, saturated, high-resolution print quality; the free areas are calm and low-contrast so that colorful product cards stay readable on top.',
    ...(input.correctionLines ?? []),
    outerTextBlock(input.exactText),
  ].join('\n');
}

/**
 * Prompt fixo da derivação da Interna (PV-T7): edita a Externa e tira cabeçalho e rodapé, arte contínua e sem calha.
 * Nunca leva pedido do cliente, ano nem brief.
 */
export function buildInnerPrompt(input: TabloidPromptInput): string {
  const m = measuresOf(input);
  return [
    'Edit the provided image. It is the OUTER side of a 4-page newspaper flyer. Create the INNER side of the same sheet from it: the same printed piece, same artwork family, with the header and the footer removed.',
    `Format and use: ${sheetText(input.format, m)}. The inner side is the spread of pages 2 and 3, folded vertically at the exact center (x = ${m.foldX} px), seen as ONE continuous screen with no seam, no border and no visible dividing line.`,
    `Composition: remove the header, its title and every decorative object of the header, and the footer band completely, from the top edge to the bottom edge; paint the background there as the natural continuation of the same picture. The whole canvas is a free, calm background for product cards: no header, no footer, no objects, no illustration, no title. Keep a vertical safe strip ${m.foldTo - m.foldFrom} px wide centered on the fold (${foldStrip(m)}) with only plain, even background, with no light source, no bright ray, no bokeh and no curved streak crossing it. Do NOT draw a gutter, book-spine shadow, darker or lighter vertical band, crease or page edge at the center: the color and brightness at x = ${m.foldX} px must be identical to the color and brightness 400 px to its left and right, as one seamless flat-lit picture.`,
    'Style: keep exactly the same style as the provided image: the same colors, the same lighting, the same motifs and texture and the same print quality. Any light burst or stronger motif stays near the outer corners only, fading to calm low-contrast background toward the center and the bottom, so the two sides of the sheet look like the same piece.',
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
