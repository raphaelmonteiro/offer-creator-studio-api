import { FLYER_PRO_LIMITS } from './flyer-pro.limits';

/** `small` (D-5): o menor lado abaixo de 300 px; o tamanho desconhecido (`null`) nunca é pequeno, o aviso fica para a medida do arquivo baixado. */
export function isSmallPhoto(width: number | null, height: number | null): boolean {
  return (
    width !== null && height !== null && Math.min(width, height) < FLYER_PRO_LIMITS.photoSmallSidePx
  );
}

/** O endereço de foto que serve: `http` ou `https` (o `data:` e o texto que não é URL não servem). */
export function isHttpImageUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Tira o resultado sem `imageUrl` http(s) e o que repete um `imageUrl` de página anterior ainda guardada (A-7, A-29); mantém a ordem. */
export function keepNewResults<T extends { imageUrl: string }>(
  results: readonly T[],
  previousUrls: ReadonlySet<string>,
): T[] {
  return results.filter(({ imageUrl }) => isHttpImageUrl(imageUrl) && !previousUrls.has(imageUrl));
}

/** `hasMore` é `false` na página sem resultado novo e na última página permitida (10). */
export const hasMorePages = (page: number, newResults: number): boolean =>
  newResults > 0 && page < FLYER_PRO_LIMITS.photoSearchPageMax;
