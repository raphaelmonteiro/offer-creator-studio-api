import { HttpStatus } from '@nestjs/common';
import type { SafeDownloadReason } from '../../../shared/http/safe-download-error';
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

/** Recusa pelas regras de `safe-image-download` (a foto não serve): 422, e nada é gravado. */
export type PhotoDownloadRefusedReason = Extract<
  SafeDownloadReason,
  'SCHEME' | 'PRIVATE_ADDRESS' | 'TOO_MANY_REDIRECTS' | 'NOT_AN_IMAGE' | 'TOO_LARGE'
>;

/** Falha da origem ou da resolução do link (`RESOLVE_FAILED`): 502, e nada é gravado. */
export type PhotoDownloadFailedReason =
  | Extract<SafeDownloadReason, 'ORIGIN_STATUS' | 'NETWORK' | 'TIMEOUT'>
  | 'RESOLVE_FAILED';

/** O `resultId` fora da resposta guardada deste encarte e item: de outro item, vencido, de antes do reinício ou inventado. */
export const flyerProPhotoResultNotFound = () =>
  flyerProError(
    HttpStatus.NOT_FOUND,
    'FLYER_PRO_PHOTO_RESULT_NOT_FOUND',
    'Resultado de busca não encontrado ou expirado.',
  );

export const flyerProPhotoDownloadRefused = (reason: PhotoDownloadRefusedReason) =>
  flyerProError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED',
    'Esta foto não pode ser baixada do site.',
    { reason },
  );

export const flyerProPhotoDownloadFailed = (reason: PhotoDownloadFailedReason) =>
  flyerProError(
    HttpStatus.BAD_GATEWAY,
    'FLYER_PRO_PHOTO_DOWNLOAD_FAILED',
    'Não foi possível baixar esta foto do site.',
    { reason },
  );

const FAILED_REASONS: readonly SafeDownloadReason[] = ['ORIGIN_STATUS', 'NETWORK', 'TIMEOUT'];

/** O erro da rota para o motivo do download seguro: falha da origem é 502, qualquer recusa das regras é 422. */
export const flyerProPhotoDownloadErrorOf = (reason: SafeDownloadReason) =>
  FAILED_REASONS.includes(reason)
    ? flyerProPhotoDownloadFailed(reason as PhotoDownloadFailedReason)
    : flyerProPhotoDownloadRefused(reason as PhotoDownloadRefusedReason);
