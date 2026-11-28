import { Injectable } from '@nestjs/common';
import { slugify } from '../../common/utils/slugify';
import {
  DownloadedImage,
  DownloadImageOptions,
  downloadImageSafely,
} from '../../shared/http/download-image-safely';
import type { ManualFetch } from '../../shared/http/follow-redirects';
import { UploadsService } from '../uploads/uploads.service';
import { GalleryService } from './gallery.service';

/** A foto de fora depois de gravada em `uploads/products/` e registrada na Galeria. */
export interface RegisteredPhoto {
  url: string;
  imageId: string;
  /** Medida do arquivo gravado, com a orientação aplicada (a mesma do `FlyerProImageSizeService`). */
  width: number;
  height: number;
}

/**
 * Baixa uma foto de fora (download seguro) e a registra na Galeria: o Pixabay (`POST /v1/ai/image-download`) e a busca no
 * Google do Encarte Pro usam o mesmo caminho. Mora na Galeria porque o e2e monta o `GalleryModule` real e troca o `AiModule`.
 */
@Injectable()
export class GalleryPhotoImportService {
  /** Injetável para testes: o `fetch` do download (padrão: a conexão presa ao endereço conferido). */
  fetchImpl: ManualFetch | undefined;

  constructor(
    private readonly uploads: UploadsService,
    private readonly gallery: GalleryService,
  ) {}

  /** Baixa com as regras de `safe-image-download` (mais a regra do chamador em `options.allowUrl`) e registra a foto. */
  async downloadAndRegister(
    url: string,
    productName: string,
    options: DownloadImageOptions = {},
  ): Promise<RegisteredPhoto> {
    const image = await downloadImageSafely(url, { fetch: this.fetchImpl, ...options });
    return this.registerDownloaded(image, productName);
  }

  /**
   * Grava a foto já baixada em `uploads/products/` com a extensão e o tipo do formato decodificado e a registra na Galeria.
   * Se o registro falhar depois de gravar, o arquivo é apagado e a falha segue: nada fica em `uploads/products/`.
   */
  async registerDownloaded(image: DownloadedImage, productName: string): Promise<RegisteredPhoto> {
    const filename = `${slugify(productName)}-${Date.now()}${image.extension}`;
    const size = image.buffer.length;
    const file = {
      buffer: image.buffer,
      originalname: filename,
      size,
      mimetype: image.mimeType,
      fieldname: 'file',
      encoding: '7bit',
    } as Express.Multer.File;
    const stored = await this.uploads.uploadFile(file, 'products');
    try {
      const registered = await this.gallery.registerImage({
        filename,
        url: stored.url,
        mimeType: image.mimeType,
        size,
      });
      return { url: stored.url, imageId: registered.id, width: image.width, height: image.height };
    } catch (error) {
      await this.uploads.deleteFile(`products/${stored.id}`);
      throw error;
    }
  }
}
