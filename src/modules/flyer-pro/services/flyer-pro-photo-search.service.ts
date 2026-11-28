import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  FLYER_PRO_PHOTO_SEARCH_CONFIG,
  type PhotoSearchConfig,
} from '../config/photo-search.config';
import {
  flyerProPhotoSearchBusy,
  flyerProPhotoSearchFailed,
  flyerProPhotoSearchUnavailable,
} from '../domain/flyer-pro-photo-search.errors';
import { hasMorePages, keepNewResults } from '../domain/flyer-pro-photo-search-rules';
import { flyerProMissingFields } from '../domain/flyer-pro.errors';
import type { PhotoSearchDto } from '../dto/flyer-pro-photo-search.dto';
import type { PhotoSearchResponseDto } from '../dto/flyer-pro-photo-search-response.dto';
import {
  FLYER_PRO_PHOTO_SEARCH_PORT,
  type FlyerProPhotoSearchPort,
  PhotoSearchFailure,
  type PhotoSearchResult,
} from '../providers/flyer-pro-photo-search.port';
import { toPhotoSearchView } from '../views/flyer-pro-photo-search.view';
import { HourlyWindow } from './flyer-pro-hourly-window';
import {
  FlyerProPhotoSearchStore,
  type PhotoPageScope,
  type StoredPhotoPage,
} from './flyer-pro-photo-search-store';
import { assertLiveDocument } from './flyer-pro-read';

/** O termo aparado, ou o 400 de campo ausente: o pipe global pula o corpo `{}`, então o serviço o confere à mão. */
function termOf(body: PhotoSearchDto): string {
  const term = typeof body.term === 'string' ? body.term.trim() : '';
  if (term === '') throw flyerProMissingFields(['term']);
  return term;
}

/** A falha do provedor com o motivo que o 503 devolve; qualquer outro erro lançado vale `PROVIDER_ERROR`. */
const failureOf = (error: unknown): PhotoSearchFailure =>
  error instanceof PhotoSearchFailure
    ? error
    : new PhotoSearchFailure('PROVIDER_ERROR', 'Falha inesperada da busca de fotos');

/**
 * B1: a busca de fotos do item no Google. Os passos: (1) o `term` (400); (2) o encarte vivo (404); (3) o provedor com a chave
 * (503 `NO_API_KEY`); (4) a resposta guardada do encarte, item, termo e página, que não chama nem conta; (5) o pedido igual
 * já no ar, que se junta; (6) o teto de buscas pagas do encarte (429) e a chamada ao provedor, que conta qualquer que seja o
 * fim dela (D-orq-255); (7) o filtro, o `hasMore` e a gravação da página (a falha não é guardada). Nada é gravado no banco.
 */
@Injectable()
export class FlyerProPhotoSearchService {
  private readonly logger = new Logger(FlyerProPhotoSearchService.name);
  /** As buscas que saíram para a Serper, por encarte, nos últimos 60 minutos. */
  private readonly paid = new HourlyWindow();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(FLYER_PRO_PHOTO_SEARCH_CONFIG) private readonly config: PhotoSearchConfig,
    @Inject(FLYER_PRO_PHOTO_SEARCH_PORT) private readonly port: FlyerProPhotoSearchPort,
    private readonly store: FlyerProPhotoSearchStore,
  ) {}

  async search(
    documentId: string,
    itemId: string,
    body: PhotoSearchDto,
  ): Promise<PhotoSearchResponseDto> {
    const term = termOf(body);
    const page = body.page ?? 1;
    await assertLiveDocument(this.dataSource.manager, documentId);
    const unavailable = this.port.unavailableReason();
    if (unavailable) throw flyerProPhotoSearchUnavailable(unavailable);
    const scope: PhotoPageScope = { documentId, itemId, term, page };
    const cached = this.store.read(scope);
    const stored = cached ?? (await this.store.joinInFlight(scope, () => this.searchPaid(scope)));
    return toPhotoSearchView(term, page, stored, cached !== null);
  }

  /** Passo 6 e 7: o teto, a chamada paga e a gravação da página nova. */
  private async searchPaid(scope: PhotoPageScope): Promise<StoredPhotoPage> {
    const retryAfterSeconds = this.paid.check(scope.documentId, this.config.maxPerHour);
    if (retryAfterSeconds !== null) throw flyerProPhotoSearchBusy(retryAfterSeconds);
    this.paid.record(scope.documentId);
    const results = await this.callProvider(scope);
    const fresh = keepNewResults(results, this.store.previousUrls(scope));
    return this.store.write(scope, {
      hasMore: hasMorePages(scope.page, fresh.length),
      results: fresh,
    });
  }

  /** A chamada à Serper com a linha de log dela; a falha vira o 503 com o motivo. */
  private async callProvider(scope: PhotoPageScope): Promise<PhotoSearchResult[]> {
    const startedAt = Date.now();
    try {
      const results = await this.port.search({ term: scope.term, page: scope.page });
      this.logCall(scope, 200, startedAt);
      return results;
    } catch (error) {
      const failure = failureOf(error);
      this.logCall(scope, failure.httpStatus ?? failure.reason, startedAt);
      throw flyerProPhotoSearchFailed(failure.reason);
    }
  }

  /** Uma linha por chamada paga: encarte, item, página, status e duração; nunca o termo digitado nem a chave (A-14, D-orq-258). */
  private logCall(scope: PhotoPageScope, status: number | string, startedAt: number): void {
    const line =
      `Busca de fotos no Google: documento=${scope.documentId} item=${scope.itemId} ` +
      `pagina=${scope.page} status=${status} duracao=${Date.now() - startedAt}ms`;
    if (status === 200) this.logger.log(line);
    else this.logger.warn(line);
  }
}
