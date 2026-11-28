import { Logger } from '@nestjs/common';
import {
  downloadImageSafely,
  type DownloadedImage,
} from '../../../shared/http/download-image-safely';
import { HttpProviderBase } from '../../../shared/providers/http-provider.base';
import { isGoogleGotoLink } from '../domain/flyer-pro-photo-link';
import type { PhotoSearchUnavailableReason } from '../domain/flyer-pro-photo-search.errors';
import { searchFailureOf } from './flyer-pro-photo-search.serper.failure';
import {
  type FlyerProPhotoSearchPort,
  PhotoLinkResolveFailure,
  PhotoSearchFailure,
  type PhotoSearchQuery,
  type PhotoSearchResult,
} from './flyer-pro-photo-search.port';
import { parseSerperImages, resolvedUrlOf } from './flyer-pro-photo-search.serper.response';

const SERPER_URL = 'https://google.serper.dev';
/**
 * O prazo da busca e o da resolução do link (A-12, D-orq-251); passado ele, a chamada é abortada e nunca repetida. Cobre
 * também a leitura do corpo (`timeoutCoversBody`, D-orq-267): um corpo que trava depois dos cabeçalhos é `TIMEOUT`, e o
 * pedido igual no ar (A-8) não fica preso junto.
 */
const SERPER_TIMEOUT_MS = 10_000;

/** País, idioma e quantidade fixos no servidor (spec "País, idioma e quantidade fixos no servidor"). */
const FIXED_PARAMS = { gl: 'br', hl: 'pt-br', num: 10 } as const;

/** O endereço de uma resolução só vale se for http(s) e não for outro link do Google (nem o mesmo de volta). */
function isResolvedAddress(link: string, resolved: string): boolean {
  if (resolved === link || isGoogleGotoLink(resolved)) return false;
  try {
    const { protocol } = new URL(resolved);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A busca de fotos pela Serper (Google Imagens). A chave vai só no cabeçalho `X-API-KEY` (nunca na URL, no corpo, em log
 * nem em mensagem de erro) e a API sobe sem ela: `unavailableReason()` responde `NO_API_KEY` e o serviço nem chama. Cada
 * chamada tem 10 s e nunca é repetida (cada uma custa crédito, e a que estoura o prazo pode ter sido cobrada).
 */
export class SerperPhotoSearch extends HttpProviderBase implements FlyerProPhotoSearchPort {
  protected readonly logger = new Logger(SerperPhotoSearch.name);
  readonly source = 'serper' as const;

  constructor(private readonly apiKey: string | undefined) {
    super();
  }

  unavailableReason(): PhotoSearchUnavailableReason | null {
    return this.apiKey ? null : 'NO_API_KEY';
  }

  async search({ term, page }: PhotoSearchQuery): Promise<PhotoSearchResult[]> {
    let raw: unknown;
    try {
      raw = await this.post('/images', { q: term, ...FIXED_PARAMS, page });
    } catch (error) {
      throw searchFailureOf(error);
    }
    const results = parseSerperImages(raw);
    if (!results)
      throw new PhotoSearchFailure('PROVIDER_ERROR', 'Resposta da Serper fora da forma');
    return results;
  }

  async resolveLink(link: string): Promise<string> {
    let resolved: string | null;
    try {
      resolved = resolvedUrlOf(await this.post('/resolve', { images: [{ imageUrl: link }] }));
    } catch {
      throw new PhotoLinkResolveFailure('A resolução do link do Google falhou');
    }
    if (!resolved || !isResolvedAddress(link, resolved)) {
      throw new PhotoLinkResolveFailure('A resolução não devolveu um endereço de foto');
    }
    return resolved;
  }

  fetchPhoto(imageUrl: string): Promise<DownloadedImage> {
    return downloadImageSafely(imageUrl);
  }

  private post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request<unknown>(SERPER_URL + path, {
      method: 'POST',
      headers: { 'X-API-KEY': this.apiKey ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: SERPER_TIMEOUT_MS,
      timeoutCoversBody: true,
    });
  }
}
