import type { McCarouselLine, McScriptScene } from './mc-types';
import type { McScriptIssue } from './mc-script-v2';

/**
 * Roteiro curto da peça de ofertas (change video-fala-continua, D11/P-21) — funções PURAS.
 * Na peça o papel da fala vem do VÍNCULO com a oferta (`productRef`), não da posição:
 * abertura e fechamento são opcionais. O `offer_carousel` segue por posição
 * (`deriveCarouselLines`).
 */

/** Papel de cada fala da peça: com oferta = `offer`; sem oferta antes da 1ª fala de oferta = `opening`, depois = `closing`. */
export function derivePieceLines(scenes: McScriptScene[]): McCarouselLine[] {
  const firstOffer = scenes.findIndex((s) => !!s.productRef);
  const boundary = firstOffer === -1 ? scenes.length : firstOffer;
  return scenes.map((scene, position) => ({
    sceneId: scene.sceneId as string,
    kind: scene.productRef ? 'offer' : position < boundary ? 'opening' : 'closing',
    offerRef: scene.productRef ?? null,
  }));
}

/** Ofertas faladas = N: o roteiro tem de N (uma por oferta) a N + 2 falas (abertura e fechamento opcionais). */
export function pieceLinesCountIssue(sceneCount: number, offerCount: number): McScriptIssue | null {
  const min = Math.max(1, offerCount);
  const max = offerCount + 2;
  if (sceneCount >= min && sceneCount <= max) return null;
  const message =
    sceneCount < min
      ? `O roteiro precisa de pelo menos ${min} ${min === 1 ? 'fala' : 'falas'}: uma por oferta falada; abertura e fechamento são opcionais.`
      : `O roteiro aceita no máximo ${max} falas: abertura (opcional), uma por oferta falada e fechamento (opcional) — tem ${sceneCount}.`;
  return { code: 'CAROUSEL_LINES_COUNT', element: 'lines', message };
}

/** Abertura só como 1ª fala e fechamento só como última; fala sem oferta entre ofertas cai aqui. */
export function pieceLineKindIssue(
  line: McCarouselLine,
  position: number,
  total: number,
): McScriptIssue | null {
  const misplaced =
    (line.kind === 'opening' && position !== 0) ||
    (line.kind === 'closing' && position !== total - 1);
  if (!misplaced) return null;
  return {
    code: 'CAROUSEL_LINE_KIND',
    sceneId: line.sceneId,
    element: 'lines',
    message:
      `Fala ${position + 1}: a fala sem oferta só pode ser a abertura (a primeira, antes das ` +
      'ofertas) ou o fechamento (a última, depois delas); entre as ofertas, cada fala apresenta uma oferta.',
  };
}
