import { HttpException } from '@nestjs/common';
import {
  flyerProPhotoDownloadErrorOf,
  flyerProPhotoDownloadFailed,
  flyerProPhotoDownloadRefused,
  flyerProPhotoResultNotFound,
  flyerProPhotoSearchBusy,
  flyerProPhotoSearchFailed,
  flyerProPhotoSearchUnavailable,
} from './flyer-pro-photo-search.errors';

const shape = (error: HttpException) => ({ status: error.getStatus(), body: error.getResponse() });

describe('erros da busca de fotos', () => {
  it('429 BUSY com HOURLY_LIMIT e os segundos até a janela abrir', () => {
    expect(shape(flyerProPhotoSearchBusy(600))).toEqual({
      status: 429,
      body: {
        code: 'FLYER_PRO_PHOTO_SEARCH_BUSY',
        message: 'Limite de buscas de fotos por hora atingido.',
        details: { reason: 'HOURLY_LIMIT', retryAfterSeconds: 600 },
      },
    });
  });

  it('503 UNAVAILABLE com NO_API_KEY', () => {
    expect(shape(flyerProPhotoSearchUnavailable('NO_API_KEY'))).toMatchObject({
      status: 503,
      body: { code: 'FLYER_PRO_PHOTO_SEARCH_UNAVAILABLE', details: { reason: 'NO_API_KEY' } },
    });
  });

  it.each(['TIMEOUT', 'AUTH', 'QUOTA', 'PROVIDER_ERROR'] as const)(
    '503 FAILED com %s',
    (reason) => {
      expect(shape(flyerProPhotoSearchFailed(reason))).toMatchObject({
        status: 503,
        body: { code: 'FLYER_PRO_PHOTO_SEARCH_FAILED', details: { reason } },
      });
    },
  );

  it('404 FLYER_PRO_PHOTO_RESULT_NOT_FOUND, sem details', () => {
    expect(shape(flyerProPhotoResultNotFound())).toEqual({
      status: 404,
      body: {
        code: 'FLYER_PRO_PHOTO_RESULT_NOT_FOUND',
        message: 'Resultado de busca não encontrado ou expirado.',
      },
    });
  });

  it.each([
    'SCHEME',
    'PRIVATE_ADDRESS',
    'TOO_MANY_REDIRECTS',
    'NOT_AN_IMAGE',
    'TOO_LARGE',
  ] as const)('422 DOWNLOAD_REFUSED com %s', (reason) => {
    expect(shape(flyerProPhotoDownloadRefused(reason))).toMatchObject({
      status: 422,
      body: { code: 'FLYER_PRO_PHOTO_DOWNLOAD_REFUSED', details: { reason } },
    });
  });

  it.each(['ORIGIN_STATUS', 'NETWORK', 'TIMEOUT', 'RESOLVE_FAILED'] as const)(
    '502 DOWNLOAD_FAILED com %s',
    (reason) => {
      expect(shape(flyerProPhotoDownloadFailed(reason))).toMatchObject({
        status: 502,
        body: { code: 'FLYER_PRO_PHOTO_DOWNLOAD_FAILED', details: { reason } },
      });
    },
  );

  it.each([
    ['SCHEME', 422],
    ['PRIVATE_ADDRESS', 422],
    ['TOO_MANY_REDIRECTS', 422],
    ['NOT_AN_IMAGE', 422],
    ['TOO_LARGE', 422],
    ['ORIGIN_STATUS', 502],
    ['NETWORK', 502],
    ['TIMEOUT', 502],
  ] as const)('o motivo %s do download seguro vira o status %s', (reason, status) => {
    const error = flyerProPhotoDownloadErrorOf(reason);

    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toMatchObject({ details: { reason } });
  });
});
