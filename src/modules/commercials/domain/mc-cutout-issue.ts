import type { McCutoutClipMetrics } from './mc-cutout-quality';

/** Motivos de reprovação do recorte e o `cutoutIssue` do projeto (change video-mascote-transparente, D7). */

export const MC_CUTOUT_REASONS = [
  'matte_empty',
  'matte_full',
  'background_not_key',
  'background_unstable',
  'key_residue',
  'edge_fringe',
] as const;
export type McCutoutReason = (typeof MC_CUTOUT_REASONS)[number];

/** Textos pt-BR de cada motivo (uma tabela, no código). */
export const MC_CUTOUT_REASON_MESSAGES: Record<McCutoutReason, string> = {
  matte_empty: 'A personagem não foi encontrada no quadro.',
  matte_full: 'O recorte pegou o quadro quase inteiro.',
  background_not_key: 'O fundo da fala saiu de outra cor que não a de recorte.',
  background_unstable: 'O fundo mudou de tom durante a fala.',
  key_residue: 'Sobrou a cor do fundo dentro da personagem.',
  edge_fringe: 'Ficou um halo da cor do fundo na borda da personagem.',
};

export const CHARACTER_CUTOUT_FAILED = 'character_cutout_failed';

/** Mensagem padrão do projeto em `needs_attention` (pt-BR). */
export function cutoutFailureMessage(failedScenes: number): string {
  return (
    `O recorte da personagem ficou com falhas em ${failedScenes} fala(s) (fundo instável, ` +
    'resto da cor de fundo ou halo na borda). Gere a fala de novo ou use um painel liso.'
  );
}

/** Cena reprovada como o `cutoutIssue` do projeto expõe (motivos com texto em pt-BR). */
export interface McCutoutIssueScene {
  sceneId: string;
  idx: number;
  reasons: Array<{ code: McCutoutReason; message: string }>;
  metrics: Partial<McCutoutClipMetrics>;
}

export interface McCutoutIssue {
  code: typeof CHARACTER_CUTOUT_FAILED;
  message: string;
  keyColor: string | null;
  scenes: McCutoutIssueScene[];
  /** Espelho de `availableActions`. */
  actions: string[];
}

/** `cutoutIssue` de `GET projects/:id` a partir do detalhe do evento `cutout_rejected` (D7). */
export function buildCutoutIssue(
  detail: Record<string, unknown> | null | undefined,
  actions: string[],
): McCutoutIssue {
  const rawScenes = Array.isArray(detail?.scenes)
    ? (detail?.scenes as Array<Record<string, unknown>>)
    : [];
  const scenes: McCutoutIssueScene[] = rawScenes.map((s) => ({
    sceneId: String(s.sceneId),
    idx: Number(s.idx),
    reasons: (Array.isArray(s.reasons) ? (s.reasons as McCutoutReason[]) : [])
      .filter((code) => code in MC_CUTOUT_REASON_MESSAGES)
      .map((code) => ({ code, message: MC_CUTOUT_REASON_MESSAGES[code] })),
    metrics: (s.metrics ?? {}) as Partial<McCutoutClipMetrics>,
  }));
  return {
    code: CHARACTER_CUTOUT_FAILED,
    message: cutoutFailureMessage(scenes.length),
    keyColor: typeof detail?.keyColor === 'string' ? detail.keyColor : null,
    scenes,
    actions,
  };
}
