import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PhotoSearchConfig } from '../config/photo-search.config';
import { readSerperApiKey } from '../config/serper-api-key';
import { MockFlyerProPhotoSearch } from './flyer-pro-photo-search.mock';
import type { FlyerProPhotoSearchPort } from './flyer-pro-photo-search.port';
import { SerperPhotoSearch } from './flyer-pro-photo-search.serper';

/**
 * Escolhe o provedor por `FLYER_PRO_PHOTO_SEARCH_PROVIDER` (já resolvido em `real` ou `mock` pela configuração, que avisa
 * no log do valor desconhecido). O `real` sobe mesmo sem `SERPER_API_KEY`, com um aviso sem valor: a busca responde 503
 * `NO_API_KEY` até a chave existir, e a API nunca falha ao subir.
 */
export function createPhotoSearchPort(
  config: PhotoSearchConfig,
  configService: ConfigService,
  logger: Pick<Logger, 'warn'> = new Logger('FlyerProPhotoSearch'),
): FlyerProPhotoSearchPort {
  if (config.provider === 'mock') return new MockFlyerProPhotoSearch();
  const apiKey = readSerperApiKey(configService);
  if (!apiKey) {
    logger.warn(
      'FLYER_PRO_PHOTO_SEARCH_PROVIDER=real sem SERPER_API_KEY: a busca de fotos no Google responde 503 NO_API_KEY',
    );
  }
  return new SerperPhotoSearch(apiKey);
}
