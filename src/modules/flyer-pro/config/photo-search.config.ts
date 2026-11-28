import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FLYER_PRO_LIMITS } from '../domain/flyer-pro.limits';
import { ProviderName, readIntegerEnv, readProviderEnv, Warner } from './env-reader';

/** Token de injeção da configuração da busca de fotos, lida uma vez ao subir (mudar exige reiniciar). */
export const FLYER_PRO_PHOTO_SEARCH_CONFIG = 'FLYER_PRO_PHOTO_SEARCH_CONFIG';

export type PhotoSearchProviderName = ProviderName;

/** A busca de fotos no Google (rotas B1 e B2): sem a chave da Serper, que nunca entra aqui (`serper-api-key.ts`). */
export interface PhotoSearchConfig {
  provider: PhotoSearchProviderName;
  /** Buscas que saíram para a Serper por encarte em 60 minutos. */
  maxPerHour: number;
}

const PREFIX = 'FLYER_PRO_PHOTO_SEARCH_';

/** As duas variáveis `FLYER_PRO_PHOTO_SEARCH_*`, lidas ao subir, com os padrões do contrato e um aviso por valor inválido. */
export function readPhotoSearchConfig(
  config: ConfigService,
  logger: Warner = new Logger('FlyerProPhotoSearchConfig'),
): PhotoSearchConfig {
  return {
    provider: readProviderEnv(config, logger, PREFIX + 'PROVIDER'),
    maxPerHour: readIntegerEnv(config, logger, {
      name: PREFIX + 'MAX_PER_HOUR',
      fallback: FLYER_PRO_LIMITS.photoSearchMaxPerHourDefault,
      min: 1,
    }),
  };
}
