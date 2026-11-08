import { computeSceneZones, SceneFormatSpec } from './scene-formats';
import { zoneBands } from './scene-zone-bands';
import { Rect, SceneZoneName, SceneZones } from './scene.types';

/**
 * Faces da cena (change add-template-scene-faces): uma face (`single`, igual ao que sempre existiu) ou frente e
 * verso (`front_back`, só nos formatos em retrato, D-9). Tudo aqui é função pura sobre o formato e a chave da face.
 */

export const SCENE_LAYOUTS = ['single', 'front_back'] as const;
export type SceneLayout = (typeof SCENE_LAYOUTS)[number];

export const FACE_KEYS = ['single', 'front', 'back'] as const;
export type FaceKey = (typeof FACE_KEYS)[number];

/** Os 7 formatos em retrato que aceitam frente e verso (D-9). Espelhado no front em `constants/templateScene.ts`. */
export const FRONT_BACK_FORMAT_IDS: readonly string[] = [
  'revista-20x26.5',
  'revista-13x19.5',
  'folheto-27x54',
  'folheto-27x40',
  'folheto-27x30',
  'folheto-20x27',
  'folheto-10x13',
];

export const acceptsFrontBack = (formatId: string): boolean =>
  FRONT_BACK_FORMAT_IDS.includes(formatId);

/** O que cada face da cena tem de fixo: posição, chave e rótulo (nulo na face única). */
export interface FaceSpec {
  index: number;
  key: FaceKey;
  label: string | null;
}

const LAYOUT_FACES: Readonly<Record<SceneLayout, readonly FaceSpec[]>> = {
  single: [{ index: 0, key: 'single', label: null }],
  front_back: [
    { index: 0, key: 'front', label: 'Frente' },
    { index: 1, key: 'back', label: 'Verso' },
  ],
};

export const facesOfLayout = (layout: SceneLayout): readonly FaceSpec[] => LAYOUT_FACES[layout];

/** A chave da face pelo índice, sem consultar o banco: as faces nunca são reordenadas nem apagadas (PV-1). */
export function faceKeyOf(layout: SceneLayout, faceIndex: number): FaceKey {
  return (LAYOUT_FACES[layout][faceIndex] ?? LAYOUT_FACES[layout][0]).key;
}

const noZone = (y: number): Rect => ({ x: 0, y, w: 1, h: 0 });

/**
 * Zonas da face (PV-3): `single` = as do formato; `front` = cabeçalho do formato e rodapé de altura 0; `back` =
 * cabeçalho de altura 0 e rodapé do formato. O miolo ocupa o que sobra.
 */
export function faceZones(format: SceneFormatSpec, key: FaceKey): SceneZones {
  const zones = computeSceneZones(format);
  if (key === 'front') {
    const header = zones.header.h;
    return {
      header: zones.header,
      body: { x: 0, y: header, w: 1, h: 1 - header },
      footer: noZone(1),
    };
  }
  if (key === 'back') {
    const footer = zones.footer.h;
    return { header: noZone(0), body: { x: 0, y: 0, w: 1, h: 1 - footer }, footer: zones.footer };
  }
  return zones;
}

/** Nome do template da face: o da cena (face única) ou "<nome> — Frente" / "<nome> — Verso" (D-8). */
export function faceTemplateName(sceneName: string, face: { label: string | null }): string {
  return face.label ? `${sceneName} — ${face.label}` : sceneName;
}

/** A face tem a zona (altura maior que 0)? */
export const hasZone = (zones: SceneZones, name: SceneZoneName): boolean => zones[name].h > 0;

/**
 * PV-9: zona que a face não tem (rodapé na frente, cabeçalho no verso) é executada como miolo; o lado não muda.
 * `marked` e `whole` passam como estão.
 */
export function effectiveZone<T extends string>(zone: T, zones: SceneZones): T | 'body' {
  const name: string = zone;
  if ((name === 'header' || name === 'footer') && !hasZone(zones, name)) return 'body';
  return zone;
}

/** Retângulo da zona; a que a face não tem vira o miolo (PV-9). */
export function zoneRect(zones: SceneZones, name: SceneZoneName): Rect {
  return zones[effectiveZone(name, zones) as SceneZoneName];
}

/** Topo calmo do verso, em cm (D-4). */
export const BACK_CALM_TOP_CM = 2;

export interface BackPromptInput {
  format: SceneFormatSpec;
  widthPx: number;
  heightPx: number;
  /** Zonas da face Verso. */
  zones: SceneZones;
}

/** Medidas em px do verso: topo calmo de 2 cm e início da faixa de rodapé. */
function backBands(input: BackPromptInput): { top: number; footerStart: number; ppcm: number } {
  const ppcm = input.heightPx / input.format.artHeightCm;
  return {
    top: Math.round(BACK_CALM_TOP_CM * ppcm),
    footerStart: zoneBands(input.zones, input.heightPx).footerStart,
    ppcm,
  };
}

/**
 * Prompt estrutural do verso (D-3, PV-2), em inglês, o do teste pago de 2026-11-08 (4 de 4) com as medidas por
 * variável. Fixo no código: nunca leva pedido do cliente, ano nem item do brief.
 */
export function buildBackPrompt(input: BackPromptInput): string {
  const { format, widthPx, heightPx } = input;
  const { top, footerStart, ppcm } = backBands(input);
  const orientation = heightPx >= widthPx ? 'portrait' : 'landscape';
  return [
    'Edit the provided image. It is the FRONT of a flyer sheet. Create the BACK side of the same sheet from it: the same printed piece, same artwork family.',
    `Format: ${format.artWidthCm} x ${format.artHeightCm} cm sheet art (${format.printWidthCm} x ${format.printHeightCm} cm trim plus bleed), ${orientation}, ${widthPx}x${heightPx} px, filling the whole canvas edge to edge. About ${Math.round(ppcm)} px per cm.`,
    'Keep from the provided image: the color palette, the lighting, the motifs style and the texture, so both sides look like one printed piece.',
    `Change: remove the header, the title and every decorative object of the header completely. The back has NO header, NO title and NO text of any kind. The top ${BACK_CALM_TOP_CM} cm (y from 0 to about ${top} px) is calm plain background with no objects. The lowest ${format.footerCm} cm (y from about ${footerStart} to ${heightPx} px) is a calm plain band, with no objects and no pattern, because the store footer is placed there later. Everything between is free calm background for product cards, with only very discreet motifs at the edges.`,
    'Rules: no readable text, no letters or numbers, no logos, no prices, no real brands, no identifiable people, no store name. One continuous picture without panels, strips or frames.',
  ].join('\n');
}

/**
 * Frase de preservação das edições do verso (PV-9), no fim do prompt de edição: sem cabeçalho nem título, topo e
 * faixa do rodapé calmos. Com texto pedido pelo cliente (`exact_text`), a parte "sem texto" sai, para não brigar com o
 * texto exato.
 */
export function backPreservationSentence(
  input: BackPromptInput & { withClientText: boolean },
): string {
  const { format } = input;
  const { top, footerStart } = backBands(input);
  const base = `This is the BACK side of the sheet: it has no header and no title. Do not add a header or a title. Keep the top ${BACK_CALM_TOP_CM} cm (y from 0 to about ${top} px) and the lowest ${format.footerCm} cm (y from about ${footerStart} px) calm, with no objects.`;
  return input.withClientText ? base : `${base} Do not add any text, letters, numbers or logos.`;
}
