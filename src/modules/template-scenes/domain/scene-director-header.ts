import type { DecisionInput, TurnDecision } from './scene-director-decision';
import { emptyImage } from './scene-director-image';
import { findSceneFormat, SceneFormatSpec } from './scene-formats';
import {
  headerCmOf,
  HeaderResize,
  resolveHeaderSize,
  TABLOID_FORMAT_IDS,
  tabloidZones,
} from './scene-tabloid';
import { zoneBands } from './scene-zone-bands';
import {
  headerAnnouncement,
  headerLimitNote,
  headerSameReply,
  HEADER_ONLY_TABLOID_REPLY,
  NO_HEADER_ON_INNER_REPLY,
  NO_IMAGE_REPLY,
  NO_INSTRUCTION_REPLY,
} from '../scene-texts';
import { SceneZones } from './scene.types';

/**
 * Altura do cabeçalho da capa pela conversa (change add-template-scene-tabloid, D-1, D-5, PV-T9): só no jornal. O
 * efeito vem do código sobre o pedido do Diretor (`tamanho_cabecalho` e `header_size`); nada aqui é texto livre do
 * modelo. Funções puras.
 */

const NATIVE_HEIGHT_PX = 2480;

/** O formato do jornal da face (só o 54x40 nesta change). */
const tabloidFormat = (face: { formatId?: string }): SceneFormatSpec =>
  findSceneFormat(face.formatId ?? TABLOID_FORMAT_IDS[0]) as SceneFormatSpec;

/** As zonas da Externa com a nova altura do cabeçalho; o corpo e o rodapé não mudam. */
export const zonesWithHeader = (format: SceneFormatSpec, cm: number): SceneZones =>
  tabloidZones(format, 'outer', cm);

/** A mudança de imagem que só redimensiona o cabeçalho: texto fixo do código (D-1), com os dois fins em px. */
function resizeChange(fromEnd: number, toEnd: number): string {
  return `Resize the cover header so that it ends at y = ${toEnd} px (it now ends at y = ${fromEnd} px): extend or shorten the header art, keep its style, text and the logo space, and continue the background naturally below it`;
}

function resizeDecision(
  input: DecisionInput,
  resize: Extract<HeaderResize, { kind: 'resize' }>,
): TurnDecision {
  const face = input.face as NonNullable<DecisionInput['face']>;
  const format = tabloidFormat(face);
  const zones = zonesWithHeader(format, resize.toCm);
  const height = face.heightPx ?? NATIVE_HEIGHT_PX;
  const fromEnd = zoneBands(face.zones, height).headerEnd;
  const toEnd = zoneBands(zones, height).headerEnd;
  return {
    kind: 'image',
    operation: 'redraw',
    window: true,
    discardMarking: input.marked,
    announcement: headerAnnouncement(resize.toCm, resize.limit),
    isEdit: true,
    planPatch: {
      will_change_image: true,
      image: emptyImage({
        change: resizeChange(fromEnd, toEnd),
        region: { zone: 'header', side: null },
      }),
    },
    zones,
    headerResize: { fromCm: resize.fromCm, toCm: resize.toCm },
  };
}

/**
 * `tamanho_cabecalho`: fora do jornal e na Interna, resposta fixa; na Externa sem imagem, o pedido de imagem de
 * sempre; já no limite (ou no tamanho pedido), resposta sem chamada; senão uma edição de imagem pela janela de 5 s.
 */
export function decideHeaderSize(input: DecisionInput): TurnDecision {
  const { face, plan, hasImage } = input;
  const reply = (text: string): TurnDecision => ({ kind: 'reply', reply: text });
  if (face?.layout !== 'tabloid') return reply(HEADER_ONLY_TABLOID_REPLY);
  if (face.key === 'inner') return reply(NO_HEADER_ON_INNER_REPLY);
  if (!hasImage) return reply(NO_IMAGE_REPLY);
  const format = tabloidFormat(face);
  const resize = resolveHeaderSize(headerCmOf(face.zones, format), plan.header_size, format);
  if (resize.kind === 'unclear') return reply(NO_INSTRUCTION_REPLY);
  if (resize.kind === 'same') return reply(headerSameReply(resize.cm, resize.limit));
  return resizeDecision(input, resize);
}

/**
 * Tamanho do cabeçalho dito junto do pedido de imagem (primeira imagem e imagem nova da Externa): as zonas mudam antes
 * do prompt, sem chamada a mais. Pedido fora do limite fica no limite, e o anúncio diz.
 */
export function headerOfGeneration(
  input: DecisionInput,
): { zones: SceneZones; note: string } | null {
  const { face, plan } = input;
  if (face?.layout !== 'tabloid' || face.key !== 'outer' || !plan.header_size) return null;
  const format = tabloidFormat(face);
  const resize = resolveHeaderSize(headerCmOf(face.zones, format), plan.header_size, format);
  if (resize.kind === 'unclear') return null;
  const toCm = resize.kind === 'resize' ? resize.toCm : resize.cm;
  if (resize.kind === 'same' && !resize.limit) return null;
  return {
    zones: zonesWithHeader(format, toCm),
    note: resize.limit ? headerLimitNote(toCm, resize.limit) : '',
  };
}
