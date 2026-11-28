import type { DataSource } from 'typeorm';
import type { DownloadedImage } from '../../../shared/http/download-image-safely';
import type {
  GalleryPhotoImportService,
  RegisteredPhoto,
} from '../../gallery/gallery-photo-import.service';
import type { PhotoSearchConfig } from '../config/photo-search.config';
import {
  type FlyerProPhotoSearchPort,
  PhotoSearchFailure,
  type PhotoSearchResult,
} from '../providers/flyer-pro-photo-search.port';
import type { PhotoDownloadDto } from '../dto/flyer-pro-photo-download.dto';
import type { PhotoSearchDto } from '../dto/flyer-pro-photo-search.dto';
import { FlyerProPhotoDownloadService } from './flyer-pro-photo-download.service';
import { FlyerProPhotoSearchService } from './flyer-pro-photo-search.service';
import {
  FlyerProPhotoSearchStore,
  type PhotoPageScope,
  type StoredPhotoResult,
} from './flyer-pro-photo-search-store';

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
  over: Partial<
    Pick<FlyerProPhotoSearchPort, 'source' | 'unavailableReason' | 'resolveLink' | 'fetchPhoto'>
  > = {},
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

export const bodyOfDownload = (resultId: string): PhotoDownloadDto => ({ resultId });

/** A foto que o download seguro entrega: um JPEG do tamanho dado (os bytes não são lidos pelo serviço). */
export const downloaded = (width = 1000, height = 1000): DownloadedImage => ({
  buffer: Buffer.from('jpeg'),
  format: 'jpeg',
  width,
  height,
  extension: '.jpg',
  mimeType: 'image/jpeg',
});

/** Guarda uma página de um resultado no `store` e devolve o resultado guardado (com o `resultId`). */
export function storeResult(
  store: FlyerProPhotoSearchStore,
  result: PhotoSearchResult,
  over: Partial<PhotoPageScope> = {},
): StoredPhotoResult {
  const scope = {
    documentId: DOCUMENT_ID,
    itemId: ITEM_ID,
    term: 'COXÃO MOLE BIFE KG',
    page: 1,
    ...over,
  };
  return store.write(scope, { hasMore: true, results: [result] }).results[0];
}

/** O serviço comum da Galeria de mentira: cada registro devolve um `imageId` novo e a medida do arquivo que recebeu. */
export function fakeGalleryImport(fail?: Error) {
  let count = 0;
  const registerDownloaded = jest.fn(
    async (image: DownloadedImage, _productName: string): Promise<RegisteredPhoto> => {
      if (fail) throw fail;
      count += 1;
      return {
        url: `http://localhost:3101/uploads/products/foto-${count}.jpg`,
        imageId: `galeria-${count}`,
        width: image.width,
        height: image.height,
      };
    },
  );
  return {
    gallery: { registerDownloaded } as unknown as GalleryPhotoImportService,
    registerDownloaded,
  };
}

export interface DownloadServiceOptions {
  /** O encarte lido (`null`: não existe ou foi excluído). */
  document?: { id: string } | null;
  port?: FlyerProPhotoSearchPort;
  store?: FlyerProPhotoSearchStore;
  gallery?: GalleryPhotoImportService;
}

export function makePhotoDownloadService(options: DownloadServiceOptions = {}) {
  const findOne = jest
    .fn()
    .mockResolvedValue(options.document === undefined ? { id: DOCUMENT_ID } : options.document);
  const dataSource = { manager: { findOne } } as unknown as DataSource;
  const store = options.store ?? new FlyerProPhotoSearchStore();
  const { gallery, registerDownloaded } = fakeGalleryImport();
  const service = new FlyerProPhotoDownloadService(
    dataSource,
    options.port ?? fakePhotoPort().port,
    store,
    options.gallery ?? gallery,
  );
  return { service, store, findOne, registerDownloaded };
}
