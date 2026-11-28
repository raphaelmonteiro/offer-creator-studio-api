import type { DownloadedImage } from '../../../shared/http/download-image-safely';
import type {
  PhotoSearchFailureReason,
  PhotoSearchUnavailableReason,
} from '../domain/flyer-pro-photo-search.errors';

/** Token de injeção do provedor da busca de fotos (`real`, a Serper, ou `mock`, escolhido por variável ao subir). */
export const FLYER_PRO_PHOTO_SEARCH_PORT = 'FLYER_PRO_PHOTO_SEARCH_PORT';

/** O pedido de uma página: o termo já aparado e a página de 1 a 10 (país, idioma e quantidade são do provedor). */
export interface PhotoSearchQuery {
  term: string;
  page: number;
}

/**
 * Um resultado com a forma do contrato: o que o provedor não trouxe já vem preenchido (`domain` pelo host do `imageUrl`,
 * `title` vazio, `thumbnailUrl` e o tamanho `null`; só a largura ou só a altura valem os dois `null`, A-25 e A-30).
 * O `imageUrl` é o endereço da foto original e nunca sai na resposta da API.
 */
export interface PhotoSearchResult {
  imageUrl: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  domain: string;
  title: string;
}

/**
 * O provedor da busca de fotos no Google. Falha da busca é `PhotoSearchFailure` e da resolução do link é
 * `PhotoLinkResolveFailure`; nenhuma das duas chamadas se repete sozinha.
 */
export interface FlyerProPhotoSearchPort {
  /** `serper` (a busca paga) ou `mock` (simulado, sem rede e sem custo). */
  readonly source: 'serper' | 'mock';
  /** Por que o provedor não pode ser chamado agora (sem chave), ou `null`. O simulado nunca depende de nada. */
  unavailableReason(): PhotoSearchUnavailableReason | null;
  /** Até 10 resultados da página, na ordem do provedor, sem o filtro de endereço nem de repetidos (é do serviço). */
  search(query: PhotoSearchQuery): Promise<PhotoSearchResult[]>;
  /** O endereço real de um link de redirecionamento do Google; sem custo e fora do teto de buscas. */
  resolveLink(link: string): Promise<string>;
  /** Baixa e lê a foto de um endereço de resultado (as regras do download seguro); o simulado gera a foto, sem rede. */
  fetchPhoto(imageUrl: string): Promise<DownloadedImage>;
}

/** Falha da busca com o motivo que o 503 devolve; `httpStatus` é o da recusa do provedor, quando houve resposta. */
export class PhotoSearchFailure extends Error {
  constructor(
    readonly reason: PhotoSearchFailureReason,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'PhotoSearchFailure';
  }
}

/** A resolução do link do Google não deu um endereço: erro, prazo, link ainda não pronto ou resposta fora da forma. */
export class PhotoLinkResolveFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoLinkResolveFailure';
  }
}
