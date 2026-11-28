import type { DataSource } from 'typeorm';
import type { PhotoSearchConfig } from '../config/photo-search.config';
import {
  type FlyerProPhotoSearchPort,
  PhotoSearchFailure,
  type PhotoSearchResult,
} from '../providers/flyer-pro-photo-search.port';
import type { PhotoSearchDto } from '../dto/flyer-pro-photo-search.dto';
import { FlyerProPhotoSearchService } from './flyer-pro-photo-search.service';
import { FlyerProPhotoSearchStore } from './flyer-pro-photo-search-store';

/** Ajudantes dos unitários da busca de fotos (só testes): o serviço sobre um banco e um provedor simulados. */

export const DOCUMENT_ID = '2c1d7e9b-4f6a-4b1e-9a3d-7e5f0c8b6a21';
export const OTHER_DOCUMENT_ID = '9a0c4e12-77b3-4c5d-8e21-0f3a6b9d2c44';
export const ITEM_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_ITEM_ID = '22222222-2222-4222-8222-222222222222';
export const CONFIG: PhotoSearchConfig = { provider: 'real', maxPerHour: 300 };

/** Um resultado do provedor: `n` dá o endereço e o tamanho (1000 × 1000 por padrão). */
export const photo = (n: number, over: Partial<PhotoSearchResult> = {}): PhotoSearchResult => ({
  imageUrl: `https://www.extrabom.com.br/img/${n}.jpg`,
  thumbnailUrl: `https://encrypted-tbn0.gstatic.com/images?q=tbn:${n}`,
  width: 1000,
  height: 1000,
  domain: 'extrabom.com.br',
  title: `Foto ${n}`,
  ...over,
});

/** Dez resultados novos, de `from` a `from + 9`. */
export const tenPhotos = (from = 1): PhotoSearchResult[] =>
  Array.from({ length: 10 }, (_, i) => photo(from + i));

export const bodyOf = (term: string, page?: number): PhotoSearchDto =>
  ({ term, ...(page === undefined ? {} : { page }) }) as PhotoSearchDto;

type Outcome = PhotoSearchResult[] | Error | (() => Promise<PhotoSearchResult[]>);

/** O provedor de mentira: devolve (ou lança) o que o teste manda e guarda os pedidos recebidos. */
export function fakePhotoPort(
  outcome: Outcome = tenPhotos(),
  over: Partial<Pick<FlyerProPhotoSearchPort, 'source' | 'unavailableReason'>> = {},
) {
  const search = jest.fn(() => {
    if (outcome instanceof Error) return Promise.reject(outcome);
    return typeof outcome === 'function' ? outcome() : Promise.resolve(outcome);
  });
  const port: FlyerProPhotoSearchPort = {
    source: 'serper',
    unavailableReason: () => null,
    search,
    resolveLink: jest.fn(),
    fetchPhoto: jest.fn(),
    ...over,
  };
  return { port, search };
}

export const failure = (reason: PhotoSearchFailure['reason'], httpStatus?: number) =>
  new PhotoSearchFailure(reason, `falha ${reason}`, httpStatus);

export interface ServiceOptions {
  config?: Partial<PhotoSearchConfig>;
  /** O encarte lido (`null`: não existe ou foi excluído). */
  document?: { id: string } | null;
  port?: FlyerProPhotoSearchPort;
  store?: FlyerProPhotoSearchStore;
}

export function makePhotoSearchService(options: ServiceOptions = {}) {
  const findOne = jest
    .fn()
    .mockResolvedValue(options.document === undefined ? { id: DOCUMENT_ID } : options.document);
  const dataSource = { manager: { findOne } } as unknown as DataSource;
  const port = options.port ?? fakePhotoPort().port;
  const store = options.store ?? new FlyerProPhotoSearchStore();
  const service = new FlyerProPhotoSearchService(
    dataSource,
    { ...CONFIG, ...options.config },
    port,
    store,
  );
  return { service, store, findOne };
}
