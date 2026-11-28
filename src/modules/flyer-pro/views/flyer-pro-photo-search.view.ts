import { isSmallPhoto } from '../domain/flyer-pro-photo-search-rules';
import type {
  PhotoSearchResponseDto,
  PhotoSearchResultDto,
} from '../dto/flyer-pro-photo-search-response.dto';
import type { StoredPhotoPage, StoredPhotoResult } from '../services/flyer-pro-photo-search-store';

/** O resultado da resposta: sem o `imageUrl`, com `small` calculado do tamanho informado. */
const toResultView = (result: StoredPhotoResult): PhotoSearchResultDto => ({
  resultId: result.resultId,
  thumbnailUrl: result.thumbnailUrl,
  width: result.width,
  height: result.height,
  domain: result.domain,
  title: result.title,
  small: isSmallPhoto(result.width, result.height),
});

/** A resposta de B1; `term` é o que o operador mandou, aparado (D-orq-256). */
export function toPhotoSearchView(
  term: string,
  page: number,
  stored: StoredPhotoPage,
  fromCache: boolean,
): PhotoSearchResponseDto {
  return {
    term,
    page,
    hasMore: stored.hasMore,
    fromCache,
    results: stored.results.map(toResultView),
  };
}
