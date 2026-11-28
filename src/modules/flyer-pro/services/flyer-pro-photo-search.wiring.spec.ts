import type { Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { HttpException } from '@nestjs/common';
import { FlyerProPhotoSearchController } from '../controllers/flyer-pro-photo-search.controller';
import { FLYER_PRO_PHOTO_SEARCH_CONFIG } from '../config/photo-search.config';
import { FlyerProModule } from '../flyer-pro.module';
import { FLYER_PRO_PHOTO_SEARCH_PORT } from '../providers/flyer-pro-photo-search.port';
import { captureLogs, configOf } from '../providers/flyer-pro-photo-search.testutil';
import { FlyerProPhotoSearchService } from './flyer-pro-photo-search.service';
import { FlyerProPhotoSearchStore } from './flyer-pro-photo-search-store';
import { bodyOf, DOCUMENT_ID, ITEM_ID } from './flyer-pro-photo-search.service.testutil';

const WIRED = [
  FlyerProPhotoSearchService,
  FlyerProPhotoSearchStore,
  FLYER_PRO_PHOTO_SEARCH_CONFIG,
  FLYER_PRO_PHOTO_SEARCH_PORT,
];

/** Os providers da busca de fotos exatamente como o `FlyerProModule` os declara. */
function declaredProviders(): Provider[] {
  const all = Reflect.getMetadata('providers', FlyerProModule) as Provider[];
  const tokenOf = (provider: Provider): unknown =>
    typeof provider === 'function' ? provider : (provider as { provide: unknown }).provide;
  return all.filter((provider) => WIRED.includes(tokenOf(provider) as (typeof WIRED)[number]));
}

async function controllerWith(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [FlyerProPhotoSearchController],
    providers: [
      ...declaredProviders(),
      { provide: ConfigService, useValue: configOf(env) },
      {
        provide: getDataSourceToken(),
        useValue: { manager: { findOne: async () => ({ id: DOCUMENT_ID }) } },
      },
    ],
  }).compile();
  return moduleRef.get(FlyerProPhotoSearchController);
}

/** A fiação do módulo: variáveis de ambiente, fábrica do provedor, serviço e controller (sem banco nem rede). */
describe('FlyerProModule: a busca de fotos montada', () => {
  beforeEach(() => {
    captureLogs();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('o módulo declara os quatro providers da busca de fotos', () => {
    expect(declaredProviders()).toHaveLength(WIRED.length);
  });

  it('FLYER_PRO_PHOTO_SEARCH_PROVIDER=mock: a rota responde 10 resultados simulados, sem rede', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    const controller = await controllerWith({ FLYER_PRO_PHOTO_SEARCH_PROVIDER: 'mock' });

    const view = await controller.search(DOCUMENT_ID, ITEM_ID, bodyOf('ACÉM COM OSSO KG'));

    expect(view.results).toHaveLength(10);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('padrão real sem SERPER_API_KEY: a API monta e a rota responde 503 NO_API_KEY', async () => {
    const controller = await controllerWith({});

    const error = (await controller
      .search(DOCUMENT_ID, ITEM_ID, bodyOf('x'))
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({ details: { reason: 'NO_API_KEY' } });
  });

  it('FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR chega ao serviço: com 1, a segunda busca nova é 429', async () => {
    const controller = await controllerWith({
      FLYER_PRO_PHOTO_SEARCH_PROVIDER: 'mock',
      FLYER_PRO_PHOTO_SEARCH_MAX_PER_HOUR: '1',
    });
    await controller.search(DOCUMENT_ID, ITEM_ID, bodyOf('um'));

    const error = (await controller
      .search(DOCUMENT_ID, ITEM_ID, bodyOf('dois'))
      .catch((e: unknown) => e)) as HttpException;

    expect(error.getStatus()).toBe(429);
  });
});
