import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { DownloadedImage } from '../../../shared/http/download-image-safely';
import { SafeDownloadError } from '../../../shared/http/safe-download-error';
import { GalleryPhotoImportService } from '../../gallery/gallery-photo-import.service';
import { isGoogleGotoLink } from '../domain/flyer-pro-photo-link';
import {
  flyerProPhotoDownloadErrorOf,
  flyerProPhotoDownloadFailed,
  flyerProPhotoResultNotFound,
  flyerProPhotoSearchUnavailable,
} from '../domain/flyer-pro-photo-search.errors';
import { flyerProMissingFields } from '../domain/flyer-pro.errors';
import type { PhotoDownloadDto } from '../dto/flyer-pro-photo-download.dto';
import type { PhotoDownloadResponseDto } from '../dto/flyer-pro-photo-download-response.dto';
import {
  FLYER_PRO_PHOTO_SEARCH_PORT,
  type FlyerProPhotoSearchPort,
  PhotoLinkResolveFailure,
} from '../providers/flyer-pro-photo-search.port';
import { toPhotoDownloadView } from '../views/flyer-pro-photo-download.view';
import { FlyerProPhotoSearchStore } from './flyer-pro-photo-search-store';
import { assertLiveDocument } from './flyer-pro-read';

/** O `resultId` do corpo, ou o 400 de campo ausente: o pipe global pula o corpo `{}`, então o serviço o confere à mão. */
function resultIdOf(body: PhotoDownloadDto): string {
  if (typeof body.resultId !== 'string' || body.resultId === '') {
    throw flyerProMissingFields(['resultId']);
  }
  return body.resultId;
}

/**
 * B2: baixa para a Galeria a foto de um resultado da busca. Os passos: (1) o `resultId` (400); (2) o encarte vivo (404); (3) o
 * resultado na resposta guardada do encarte e item (404, sem requisição externa); (4) o endereço: o do resultado ou, só para
 * um link de redirecionamento do Google, o resolvido pela Serper (503 `NO_API_KEY` sem a chave; 502 `RESOLVE_FAILED`);
 * (5) o download pelas regras de `safe-image-download` (422 recusa, 502 falha); (6) o arquivo em `uploads/products/` e a linha
 * na Galeria. Nada é gravado em erro, a resposta guardada continua valendo e nada aqui conta no teto de buscas pagas.
 */
@Injectable()
export class FlyerProPhotoDownloadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(FLYER_PRO_PHOTO_SEARCH_PORT) private readonly port: FlyerProPhotoSearchPort,
    private readonly store: FlyerProPhotoSearchStore,
    private readonly gallery: GalleryPhotoImportService,
  ) {}

  async download(
    documentId: string,
    itemId: string,
    body: PhotoDownloadDto,
  ): Promise<PhotoDownloadResponseDto> {
    const resultId = resultIdOf(body);
    await assertLiveDocument(this.dataSource.manager, documentId);
    const result = this.store.findResult(documentId, itemId, resultId);
    if (!result) throw flyerProPhotoResultNotFound();
    const address = await this.addressOf(result.imageUrl);
    const image = await this.fetchPhoto(address);
    return toPhotoDownloadView(await this.gallery.registerDownloaded(image, result.term));
  }

  /** O endereço a baixar: o do resultado, ou o resolvido quando ele é um link de redirecionamento do Google (0 crédito). */
  private async addressOf(imageUrl: string): Promise<string> {
    if (!isGoogleGotoLink(imageUrl)) return imageUrl;
    const unavailable = this.port.unavailableReason();
    if (unavailable) throw flyerProPhotoSearchUnavailable(unavailable);
    try {
      return await this.port.resolveLink(imageUrl);
    } catch (error) {
      if (error instanceof PhotoLinkResolveFailure)
        throw flyerProPhotoDownloadFailed('RESOLVE_FAILED');
      throw error;
    }
  }

  private async fetchPhoto(address: string): Promise<DownloadedImage> {
    try {
      return await this.port.fetchPhoto(address);
    } catch (error) {
      if (error instanceof SafeDownloadError) throw flyerProPhotoDownloadErrorOf(error.reason);
      throw error;
    }
  }
}
