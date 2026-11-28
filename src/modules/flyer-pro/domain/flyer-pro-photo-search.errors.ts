import { HttpStatus } from '@nestjs/common';
import { flyerProError } from './flyer-pro.errors';

/** Os erros da busca de fotos no Google e do download da foto escolhida (change 47). */

/** Provedor real sem `SERPER_API_KEY`: a busca responde 503 `UNAVAILABLE` sem requisição. */
export type PhotoSearchUnavailableReason = 'NO_API_KEY';

/** `TIMEOUT`: só o prazo de 10 s; `AUTH`: chave recusada; `QUOTA`: créditos acabados; `PROVIDER_ERROR`: o resto. */
export type PhotoSearchFailureReason = 'TIMEOUT' | 'AUTH' | 'QUOTA' | 'PROVIDER_ERROR';

/** O teto de buscas pagas do encarte em 60 minutos; `retryAfterSeconds` é o tempo até a mais antiga sair da janela. */
export const flyerProPhotoSearchBusy = (retryAfterSeconds: number) =>
  flyerProError(
    HttpStatus.TOO_MANY_REQUESTS,
    'FLYER_PRO_PHOTO_SEARCH_BUSY',
    'Limite de buscas de fotos por hora atingido.',
    { reason: 'HOURLY_LIMIT', retryAfterSeconds },
  );

export const flyerProPhotoSearchUnavailable = (reason: PhotoSearchUnavailableReason) =>
  flyerProError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE',
    'A busca de fotos no Google não está disponível neste ambiente.',
    { reason },
  );

/** A Serper falhou: nada é guardado e a chamada paga não se repete sozinha. */
export const flyerProPhotoSearchFailed = (reason: PhotoSearchFailureReason) =>
  flyerProError(
    HttpStatus.SERVICE_UNAVAILABLE,
    'FLYER_PRO_PHOTO_SEARCH_FAILED',
    'Não foi possível buscar as fotos.',
    { reason },
  );
