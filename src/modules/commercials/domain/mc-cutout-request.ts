/**
 * Regras puras do pedido de personagem sem fundo / enquadramento (change
 * video-mascote-transparente, D9): qual tile vai ao motor e como o pedido herda o roteiro anterior.
 */

export type McFraming = 'busto' | 'corpo';

/** Tile enviado ao motor: o de corpo no enquadramento "corpo"; senão o do kit (busto). */
export function kitTileIdForFraming(
  kit: { tileAssetId?: string | null; bodyTileAssetId?: string | null } | null | undefined,
  framing: McFraming | undefined,
): string | null | undefined {
  return framing === 'corpo' ? kit?.bodyTileAssetId : kit?.tileAssetId;
}

interface McCutoutRequestFields {
  cutout?: boolean;
  framing?: McFraming;
  logoFace?: boolean;
}

/**
 * Resolve `cutout`, `framing` e `logoFace` do pedido: o que o DTO traz vence; o que falta vem do
 * roteiro anterior; sem nenhum dos dois, sem fundo = corpo e com fundo = busto.
 */
export function resolveCutoutRequest(
  dto: McCutoutRequestFields,
  previous: McCutoutRequestFields | null | undefined,
): Required<McCutoutRequestFields> {
  const cutout = dto.cutout ?? previous?.cutout ?? false;
  return {
    cutout,
    framing: dto.framing ?? previous?.framing ?? (cutout ? 'corpo' : 'busto'),
    logoFace: dto.logoFace ?? previous?.logoFace ?? false,
  };
}

/** Pré-condição do `talk` que falta (kit/tile/tile de corpo/chave): a cotação responde `null`. */
export class McTalkPreconditionError extends Error {}
