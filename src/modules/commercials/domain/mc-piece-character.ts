import type { McPieceCharacterBlock, McPieceDocument } from './mc-piece';

/**
 * Bloco do personagem da peça: modo sem fundo e enquadramento (change
 * video-mascote-transparente, D8/D9). Funções puras sobre o descritor.
 */

export const MC_PIECE_PANEL_SHAPES = ['none', 'card', 'circle'] as const;
export const MC_PIECE_FRAMINGS = ['busto', 'corpo'] as const;
export type McPieceFraming = (typeof MC_PIECE_FRAMINGS)[number];

export type McPieceRecordingReason =
  | 'character_cutout'
  | 'character_framing'
  | 'panel_color'
  | 'character_mode';

/** Sem fundo = `panel.shape === 'none'`. */
export function characterUsesCutout(block: McPieceCharacterBlock | null | undefined): boolean {
  return block?.panel?.shape === 'none';
}

/** Enquadramento resolvido: o explícito; ausente = `corpo` no modo sem fundo, senão `busto`. */
export function resolveCharacterFraming(
  block: McPieceCharacterBlock | null | undefined,
): McPieceFraming {
  if (block?.framing === 'busto' || block?.framing === 'corpo') return block.framing;
  return characterUsesCutout(block) ? 'corpo' : 'busto';
}

export interface McCharacterFieldViolation {
  blockId: string;
  field: 'panel.shape' | 'framing';
  allowed: readonly string[];
}

/** Valores fora da lista de `panel.shape` e `framing` (o service responde 400 `PIECE_CHARACTER_FIELD_INVALID`). */
export function characterFieldViolations(document: McPieceDocument): McCharacterFieldViolation[] {
  const violations: McCharacterFieldViolation[] = [];
  for (const block of document?.blocks ?? []) {
    if (block?.type !== 'character') continue;
    const shape = block.panel?.shape as unknown;
    if (shape !== undefined && !(MC_PIECE_PANEL_SHAPES as readonly unknown[]).includes(shape)) {
      violations.push({ blockId: block.id, field: 'panel.shape', allowed: MC_PIECE_PANEL_SHAPES });
    }
    const framing = block.framing as unknown;
    if (framing !== undefined && !(MC_PIECE_FRAMINGS as readonly unknown[]).includes(framing)) {
      violations.push({ blockId: block.id, field: 'framing', allowed: MC_PIECE_FRAMINGS });
    }
  }
  return violations;
}

/**
 * Por que uma edição da peça regrava as falas (R5): `character_cutout` = `shape` entrou/saiu
 * de `none`; `character_framing` = enquadramento resolvido mudou; `panel_color` = cor mudou
 * com o painel visível nos dois lados; `character_mode` = in_piece ↔ logo_face.
 */
export function pieceRecordingReasons(
  before: McPieceCharacterBlock | null | undefined,
  after: McPieceCharacterBlock | null | undefined,
): McPieceRecordingReason[] {
  const reasons: McPieceRecordingReason[] = [];
  if (characterUsesCutout(before) !== characterUsesCutout(after)) reasons.push('character_cutout');
  if (resolveCharacterFraming(before) !== resolveCharacterFraming(after)) {
    reasons.push('character_framing');
  }
  const color = (b: McPieceCharacterBlock | null | undefined) =>
    (b?.panel?.color ?? '').trim().toUpperCase();
  const visible = !characterUsesCutout(before) && !characterUsesCutout(after);
  if (visible && color(before) !== color(after)) reasons.push('panel_color');
  if ((before?.mode ?? null) !== (after?.mode ?? null)) reasons.push('character_mode');
  return reasons;
}
