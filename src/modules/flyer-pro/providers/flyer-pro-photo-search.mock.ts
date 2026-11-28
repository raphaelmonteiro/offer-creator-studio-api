import * as sharp from 'sharp';
import type { DownloadedImage } from '../../../shared/http/download-image-safely';
import { SafeDownloadError } from '../../../shared/http/safe-download-error';
import { slugify } from '../../../common/utils/slugify';
import {
  type FlyerProPhotoSearchPort,
  PhotoLinkResolveFailure,
  type PhotoSearchQuery,
  type PhotoSearchResult,
} from './flyer-pro-photo-search.port';

/** Host que não existe: nenhum endereço do simulado resolve nem recebe conexão. */
const MOCK_HOST = 'mock-photos.invalid';
const GOTO_PREFIX = 'https://www.google.com/goto?url=';
const RESULTS_PER_PAGE = 10;

interface Side {
  width: number;
  height: number;
}

/** O resultado 2 declara 240 × 240 (foto pequena) e o 3 não declara tamanho (A-26): o arquivo do 3 também tem 240 × 240. */
const DECLARED: Record<number, Side | null> = { 2: { width: 240, height: 240 }, 3: null };
const FILES: Record<number, Side> = { 3: { width: 240, height: 240 } };
const DEFAULT_SIDE: Side = { width: 1000, height: 1000 };
/** O resultado 4 é um link de redirecionamento do Google, que o simulado resolve sem rede. */
const GOTO_POSITION = 4;
const DOMAINS = [
  'extrabom.com.br',
  'atacadao.com.br',
  'pomarbrasilia.com.br',
  'carrefour.com.br',
  'paodeacucar.com',
  'supermercadosbh.com.br',
  'mercadolivre.com.br',
  'americanas.com.br',
  'frangolandia.com.br',
  'casadascarnes.com.br',
];

const photoUrl = (term: string, page: number, position: number): string =>
  `https://${MOCK_HOST}/${slugify(term) || 'busca'}/p${page}/${position}.jpg`;

const MOCK_PHOTO_URL = /^https:\/\/mock-photos\.invalid\/[^/]+\/p\d+\/(\d+)\.jpg$/;

/** A posição (1 a 10) que a URL de foto do simulado traz no fim, ou `null` para endereço que não é dele. */
const positionOf = (imageUrl: string): number | null => {
  const match = MOCK_PHOTO_URL.exec(imageUrl);
  return match ? Number(match[1]) : null;
};

function resultAt(term: string, page: number, position: number): PhotoSearchResult {
  const declared = position in DECLARED ? DECLARED[position] : DEFAULT_SIDE;
  const direct = photoUrl(term, page, position);
  const domain = DOMAINS[position - 1];
  return {
    imageUrl: position === GOTO_POSITION ? GOTO_PREFIX + encodeURIComponent(direct) : direct,
    thumbnailUrl: `https://${MOCK_HOST}/thumb/${position}.jpg`,
    width: declared?.width ?? null,
    height: declared?.height ?? null,
    domain,
    title: `${term} - ${domain}`,
  };
}

/**
 * O provedor simulado da busca de fotos: 10 resultados fixos por termo e página (o mesmo pedido responde sempre o mesmo),
 * um de 240 × 240, um sem tamanho e um link de redirecionamento do Google; o download gera a foto com o `sharp`. Nunca abre
 * conexão e nunca custa nada.
 */
export class MockFlyerProPhotoSearch implements FlyerProPhotoSearchPort {
  readonly source = 'mock' as const;

  unavailableReason(): null {
    return null;
  }

  async search({ term, page }: PhotoSearchQuery): Promise<PhotoSearchResult[]> {
    return Array.from({ length: RESULTS_PER_PAGE }, (_, index) => resultAt(term, page, index + 1));
  }

  async resolveLink(link: string): Promise<string> {
    const target = link.startsWith(GOTO_PREFIX)
      ? decodeURIComponent(link.slice(GOTO_PREFIX.length))
      : '';
    if (positionOf(target) === null)
      throw new PhotoLinkResolveFailure('link que o simulado não conhece');
    return target;
  }

  async fetchPhoto(imageUrl: string): Promise<DownloadedImage> {
    const position = positionOf(imageUrl);
    if (position === null)
      throw new SafeDownloadError('NETWORK', 'endereço que o simulado não conhece');
    const { width, height } = FILES[position] ?? DECLARED[position] ?? DEFAULT_SIDE;
    const buffer = await sharp({ create: { width, height, channels: 3, background: '#2f7d4f' } })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { buffer, format: 'jpeg', width, height, extension: '.jpg', mimeType: 'image/jpeg' };
  }
}
