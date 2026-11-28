import { HttpException } from '@nestjs/common';
import {
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
});
